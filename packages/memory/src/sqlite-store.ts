import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  MemoryInput,
  MemoryKind,
  MemoryRecord,
  MemoryStore,
  MemorySubject,
  Pad,
  Person,
  RecallByVectorOptions,
  RecallContextOptions,
  RecallHybridOptions,
  RecallKindOptions,
  RecallWithContext,
  RecalledMemory,
  StoredMessage,
} from './types';
import {
  anchorIndex,
  bumpClosenessValue,
  cosineSimilarity,
  decayCloseness,
  decayFactor,
  decodeEmbedding,
  emotionResonance,
  encodeEmbedding,
  entityKeys,
  jaccardSimilarity,
  lshBandKeys,
  makePrimaryPerson,
  memoryKindWeight,
  normalizeAndFuse,
  personalizedPageRank,
  recallScore,
  reciprocalRankFusion,
  reinforceImportance,
  resolveAttribution,
  resolveMemoryConfig,
  resolveMemoryKind,
  ShingleCache,
  tokenize,
  windowRange,
  type MemoryConfig,
  type PprEdge,
  type RawRecallSignals,
  type RecallSignalWeights,
} from './config';

/** 当前代码支持的记忆库 schema 版本。每次破坏性/累加性变更 +1 并新增一条迁移。 */
export const CURRENT_SCHEMA_VERSION = 8;

/**
 * 迁移步骤上下文:主用户花名册条目 + 记忆重要性初值经此注入(承 §3.2 行为即配置),
 * 杜绝把身份/初值硬编码进迁移 SQL(决策 5);Person 由 makePrimaryPerson 单一构造。
 */
interface MigrationContext {
  readonly primaryPerson: Person;
  /** 评分列 backfill 的重要性初值(承 §5.5;经配置注入,不硬编码进 SQL)。 */
  readonly initialImportance: number;
}

/**
 * 顺序迁移:版本号 → 升级到该版本的步骤。用 IF NOT EXISTS 保持幂等,
 * 让"已有数据的旧库"被安全纳管而不重建(承 §3.2 数据迁移纪律)。
 */
const MIGRATIONS: Record<number, (db: DatabaseSync, ctx: MigrationContext) => void> = {
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        correlation_id TEXT
      );
      CREATE TABLE IF NOT EXISTS memories(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        normalized_text TEXT NOT NULL UNIQUE,
        kind TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 1,
        source_session TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_memories_last_seen ON memories(last_seen_at DESC);
    `);
  },
  2(db) {
    // 通用状态 KV(persona OCEAN/PAD 等复用真相源持久化)。
    db.exec(`CREATE TABLE IF NOT EXISTS kv_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  },
  3(db, ctx) {
    // 多主语 + 人物花名册(承 §5.3 / §5.3b)。单事务内完成"建表+加列+seed+backfill"。
    // 1) 人物花名册表(列对齐 §5.3b,后四列可空,为多人/用户组/Agent 自主纳入预留)。
    db.exec(`
      CREATE TABLE IF NOT EXISTS people(
        person_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        added_by TEXT NOT NULL,
        relationship_state TEXT,
        voiceprint_ref TEXT
      );
    `);
    // 2) 记忆增主语与人物归属两列(SQLite 加列默认 NULL;幂等性靠 v3 只跑一次保证)。
    db.exec(`ALTER TABLE memories ADD COLUMN subject TEXT;`);
    db.exec(`ALTER TABLE memories ADD COLUMN person_id TEXT;`);
    // 3) seed 主用户(P1 恰好一个;Person 经 ctx 注入,is_primary/status/added_by 不变式来自工厂)。
    const p = ctx.primaryPerson;
    db.prepare(
      `INSERT INTO people(person_id, name, is_primary, status, added_by)
       VALUES(?, ?, ?, ?, ?)
       ON CONFLICT(person_id) DO NOTHING`,
    ).run(p.personId, p.name, p.isPrimary ? 1 : 0, p.status, p.addedBy);
    // 4) backfill 存量记忆:旧库无主语,全部归为主用户的 person 记忆(零丢失,§3.2)。
    db.prepare(`UPDATE memories SET subject = 'person', person_id = ? WHERE subject IS NULL`).run(
      p.personId,
    );
  },
  4(db, ctx) {
    // 记忆评分列(承 §5.5):importance / access_count / last_accessed + 预留 pinned / emotion_snapshot。
    // ALTER ADD COLUMN 无列级 IF NOT EXISTS,幂等性靠 v4 只在 schema_version<4 跑一次(同 v3 手法)。
    db.exec(`ALTER TABLE memories ADD COLUMN importance REAL;`);
    db.exec(`ALTER TABLE memories ADD COLUMN access_count INTEGER;`);
    db.exec(`ALTER TABLE memories ADD COLUMN last_accessed INTEGER;`);
    db.exec(`ALTER TABLE memories ADD COLUMN pinned INTEGER;`); // 预留:核心记忆免衰(承 §5)。
    db.exec(`ALTER TABLE memories ADD COLUMN emotion_snapshot TEXT;`); // 预留:P2 情感共振。
    // backfill 历史行:重要性给配置初值、访问计数 0、非 pinned;零数据丢失(§3.2)。
    // last_accessed / emotion_snapshot 容 NULL,读取侧兜底(last_accessed→last_seen_at)。
    db.prepare(
      `UPDATE memories SET importance = ?, access_count = 0, pinned = 0 WHERE importance IS NULL`,
    ).run(ctx.initialImportance);
  },
  5(db) {
    // 未闭合话题标记(承 §7#2 主动跟进的数据层):open_thread(0/1)+ closed_at(闭合时间戳)。
    // ALTER ADD COLUMN 无列级 IF NOT EXISTS,幂等性靠 v5 只在 schema_version<5 跑一次(同 v3/v4 手法)。
    db.exec(`ALTER TABLE memories ADD COLUMN open_thread INTEGER;`);
    db.exec(`ALTER TABLE memories ADD COLUMN closed_at INTEGER;`); // NULL=尚未闭合(决策 1)。
    // backfill 历史行:旧记忆视作"非未了事";closed_at 容 NULL 即"未闭合",无需显式写。零数据丢失(§3.2)。
    db.prepare(`UPDATE memories SET open_thread = 0 WHERE open_thread IS NULL`).run();
  },
  6(db, ctx) {
    // 联想扩散的轻量实体邻接(承 §5.9 缺口①):A-MEM 式记忆关联网,端侧纯 SQLite 即可扛。
    // 1) 记忆→实体键索引(实体键= 'p:'+person_id 或 't:'+规范化 token,见 config.entityKeys)。
    //    用于"按共享实体找邻居";建索引保证邻接查询有序高效(端侧性能,§5.9)。
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_entities(
        memory_id INTEGER NOT NULL,
        entity_key TEXT NOT NULL,
        PRIMARY KEY(memory_id, entity_key)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_entities_key ON memory_entities(entity_key);
    `);
    // 2) 无向邻接边(规范化为 a<b 防双向重复;weight=共享实体累计计数,越关联越重)。
    //    两端各建索引以支持"给定一端找全部邻居"(扩散遍历,§5.9)。
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_edges(
        a INTEGER NOT NULL,
        b INTEGER NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(a, b)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_a ON memory_edges(a);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_b ON memory_edges(b);
    `);
    // backfill 存量记忆:为已有记忆补建实体索引 + 邻接边(零丢失地把旧库纳入联想网,§3.2)。
    // 注意:本迁移在 BEGIN 事务内执行(见 #migrate),与 schema_version 写入同一原子提交。
    const rows = db
      .prepare(`SELECT id, text, person_id FROM memories ORDER BY id ASC`)
      .all() as { id: number; text: string; person_id: string | null }[];
    for (const r of rows) {
      const personId = r.person_id === null ? undefined : r.person_id;
      // 注:迁移内无法访问实例 normalize;迁移用与默认一致的规范化(旧库 token 化只为建网,容差可接受)。
      linkEntitiesAndEdges(
        db,
        asNumber(r.id),
        asString(r.text),
        personId,
        defaultMigrationNormalize,
        ctx.primaryPerson.personId,
      );
    }
  },
  7(db) {
    // 情景/语义显式分层(承 §5.1 / §5.9 缺口④):新增 memory_kind 列 ∈ {episodic, semantic, core}。
    // ALTER ADD COLUMN 无列级 IF NOT EXISTS,幂等性靠 v7 只在 schema_version<7 跑一次(同 v3..v6 手法)。
    db.exec(`ALTER TABLE memories ADD COLUMN memory_kind TEXT;`);
    // backfill 存量记忆:已 pinned → core(本就免衰减的核心档);其余 → semantic(保守:旧库多为稳定事实)。
    // 单一权威推断规则见 config.inferMemoryKindForBackfill(纯函数,幂等可回放,§3.2)。
    // 用两条 UPDATE 表达"pinned→core / 非 pinned→semantic",只覆盖 memory_kind IS NULL 的历史行,零丢失。
    db.prepare(`UPDATE memories SET memory_kind = 'core' WHERE memory_kind IS NULL AND pinned = 1`).run();
    db.prepare(`UPDATE memories SET memory_kind = 'semantic' WHERE memory_kind IS NULL`).run();
  },
  8(db) {
    // 向量列(承 §5.6 接缝 7 / §5.9 接缝预留⑤):记忆向量做 **Float32 BLOB 不透明存储** + 维度。
    // ALTER ADD COLUMN 无列级 IF NOT EXISTS,幂等性靠 v8 只在 schema_version<8 跑一次(同 v3..v7 手法)。
    // 旧行 embedding/embedding_dim 留 NULL(**合法**:尚未嵌入;供 memoriesNeedingEmbedding 后台补嵌,零丢失 §3.2)。
    db.exec(`ALTER TABLE memories ADD COLUMN embedding BLOB;`); // 不透明字节;换 embedder 后台 re-embed 写回同列,免 schema 迁移。
    db.exec(`ALTER TABLE memories ADD COLUMN embedding_dim INTEGER;`); // 维度;KNN 时据此跳过维度不一致行。
    // 无 backfill:存量行 embedding 恒 NULL(语义索引是可重建派生,承 §5.6 单一真相源)。
  },
};

/**
 * 迁移期实体抽取用的规范化(承 §5.9 缺口①):与 config.defaultNormalize 同规则。
 * 迁移步骤是静态函数、拿不到实例配置;存量回填只为建联想网,与默认规则一致即可(无漂移风险)。
 */
function defaultMigrationNormalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * 写入一条记忆的实体索引,并与已有共享实体的记忆建立/增强无向邻接边(承 §5.9 缺口①)。
 * 单一权威建边规则(SQLite 侧):
 * - 实体键 = config.entityKeys(person_id + 规范化 token);
 * - 对每个实体键,找出其它已挂该键的记忆,逐一把边权 +1(共享实体越多边越重);
 * - 边规范化为 (min,max) 防无向重复;自反(自己)跳过。
 * 在 addMemory 的写事务内调用(与 INSERT memories 同一原子提交,承 §3.2)。
 */
function linkEntitiesAndEdges(
  db: DatabaseSync,
  memoryId: number,
  text: string,
  personId: string | undefined,
  normalize: (t: string) => string,
  primaryPersonId: string,
): void {
  const keys = entityKeys(text, personId, normalize, primaryPersonId);
  if (keys.length === 0) return;
  const insEntity = db.prepare(
    `INSERT INTO memory_entities(memory_id, entity_key) VALUES(?, ?) ON CONFLICT DO NOTHING`,
  );
  const findNeighbors = db.prepare(
    `SELECT DISTINCT memory_id FROM memory_entities WHERE entity_key = ? AND memory_id <> ?`,
  );
  const upsertEdge = db.prepare(
    `INSERT INTO memory_edges(a, b, weight) VALUES(?, ?, 1)
     ON CONFLICT(a, b) DO UPDATE SET weight = weight + 1`,
  );
  // 跨实体键累计:同一对记忆若共享多个键,边权按共享键数累加(在循环里多次 +1)。
  for (const key of keys) {
    const neighbors = findNeighbors.all(key, memoryId) as { memory_id: number }[];
    for (const nb of neighbors) {
      const other = asNumber(nb.memory_id);
      if (other === memoryId) continue;
      const a = Math.min(memoryId, other);
      const b = Math.max(memoryId, other);
      upsertEdge.run(a, b); // 新边 weight=1;已存在则 ON CONFLICT weight+1(共享键越多越重)。
    }
    insEntity.run(memoryId, key);
  }
}

export interface SqliteMemoryStoreOptions {
  /** DB 文件路径;':memory:' 为内存库(测试用)。 */
  readonly path: string;
  readonly config?: Partial<MemoryConfig>;
  /** 注入时钟(确定性测试)。 */
  readonly now?: () => number;
  /** 错误回调(§8.1 error 层);默认 console.error。降级时记录而非抛出。 */
  readonly onError?: (err: unknown, op: string) => void;
}

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}
function asString(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}
/**
 * 读列兜底:把 memory_kind 列值规范为 MemoryKind(承 §5.9 缺口④)。
 * v7 迁移后该列必有合法值;旧 NULL / 未知值兜底为 episodic(单一权威读列规则,与 InMemory 零漂移)。
 */
function normalizeKind(v: unknown): MemoryKind {
  return v === 'semantic' || v === 'core' ? v : 'episodic';
}

/**
 * 召回取行的统一列集(单一权威):recall/联想扩散/向量 KNN 共用,杜绝列清单散落漂移。
 * 含 normalized_text 以在 JS 层复算关键词命中(与 InMemory 同规则);不含 embedding(KNN 单独取以免无谓拷贝大 BLOB)。
 */
const MEMORY_COLS = `id, text, normalized_text, kind, created_at, last_seen_at, hits, subject, person_id,
                     importance, access_count, last_accessed, pinned, open_thread, closed_at, memory_kind`;

/** 一条召回候选:记录 + 其归一前多路原始信号(recall/recallHybrid 共用,承 §5.9 缺口③)。 */
type Cand = {
  readonly record: MemoryRecord;
  readonly raw: RawRecallSignals;
};

/**
 * SQLite 记忆实现(node:sqlite,单文件真相源,§8.1)。
 * 写路径 ADD+去重(ON CONFLICT 增计数);关键词召回(token/LIKE,P1);schema 版本化+迁移。
 * 读失败优雅降级为空(不拖垮主对话,§3.2)。
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync;
  readonly #cfg: MemoryConfig;
  readonly #now: () => number;
  readonly #onError: (err: unknown, op: string) => void;
  /**
   * LSH 去重前置索引(承 §5.8 / §5.10 B2):band 键 → 落该桶记忆 id 集合 + id → shingle 集合。
   * **纯内存派生索引**(派生自 normalized_text,不持久化、免 schema 迁移;承 §5.6 语义索引是可重建派生):
   * 构造时扫描存量 normalized_text 重建,addMemory 新建时增量挂桶。与 InMemory 实现同一规则(零漂移)。
   */
  readonly #lshBuckets = new Map<string, Set<number>>();
  readonly #shingleById = new Map<number, Set<string>>();
  /** shingle/签名 LRU 缓存(承 §5.10 B2,Graphiti 式;与 InMemory 共用同一纯函数,零漂移)。 */
  readonly #shingleCache: ShingleCache;

  constructor(opts: SqliteMemoryStoreOptions) {
    this.#cfg = resolveMemoryConfig(opts.config);
    this.#now = opts.now ?? Date.now;
    this.#onError = opts.onError ?? ((err, op) => console.error(`[memory] ${op} 失败`, err));
    this.#shingleCache = new ShingleCache(this.#cfg);
    this.#db = new DatabaseSync(opts.path);
    try {
      this.#db.exec('PRAGMA journal_mode=WAL;');
      this.#migrate();
      // 迁移后重建 LSH 去重索引(承 §5.10 B2):扫描存量记忆 normalized_text 挂桶,把旧库纳入查重网。
      this.#rebuildLshIndex();
    } catch (err) {
      // 初始化失败(如 schema 版本过高)必须关句柄,否则 Windows 会一直锁住 DB 文件。
      this.#db.close();
      throw err;
    }
  }

  /**
   * 重建 LSH 去重索引(承 §5.8 / §5.10 B2):构造时扫描全部存量记忆的 `id, normalized_text`,
   * 按 MinHash band 键挂桶 + 存 shingle 集合(派生索引,不持久化;承 §5.6 可重建)。按 id 升序确定。
   */
  #rebuildLshIndex(): void {
    const rows = this.#db
      .prepare(`SELECT id, normalized_text FROM memories ORDER BY id ASC`)
      .all() as { id: number; normalized_text: string }[];
    for (const r of rows) {
      this.#registerLsh(asNumber(r.id), asString(r.normalized_text));
    }
  }

  #migrate(): void {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const row = this.#db.prepare(`SELECT value FROM memory_meta WHERE key = 'schema_version'`).get();
    const current = row === undefined ? 0 : asNumber(row['value']);
    if (current > CURRENT_SCHEMA_VERSION) {
      throw new Error(
        `记忆库 schema_version=${current} 高于代码支持的 ${CURRENT_SCHEMA_VERSION},拒绝打开以免损坏数据`,
      );
    }
    if (current === CURRENT_SCHEMA_VERSION) return;

    // 主用户花名册条目经配置解析后传入 MIGRATIONS(§3.2 行为即配置;决策 5)。
    const ctx: MigrationContext = {
      primaryPerson: makePrimaryPerson(this.#cfg),
      initialImportance: this.#cfg.initialImportance,
    };
    this.#db.exec('BEGIN');
    try {
      for (let v = current + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step === undefined) throw new Error(`缺少 schema v${v} 的迁移步骤`);
        step(this.#db, ctx);
      }
      this.#db
        .prepare(
          `INSERT INTO memory_meta(key, value) VALUES('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(CURRENT_SCHEMA_VERSION));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  appendMessage(msg: StoredMessage): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO messages(session_id, turn_id, role, content, created_at, correlation_id)
           VALUES(?, ?, ?, ?, ?, ?)`,
        )
        .run(msg.sessionId, msg.turnId, msg.role, msg.content, msg.createdAtMs, msg.correlationId ?? null);
    } catch (err) {
      this.#onError(err, 'appendMessage');
    }
  }

  snapshot(limit: number = this.#cfg.snapshotLimit): readonly ChatMessage[] {
    try {
      const rows = this.#db
        .prepare(`SELECT role, content FROM messages ORDER BY id DESC LIMIT ?`)
        .all(limit);
      return rows
        .map((r) => ({ role: asString(r['role']) as ChatMessage['role'], content: asString(r['content']) }))
        .reverse();
    } catch (err) {
      this.#onError(err, 'snapshot');
      return [];
    }
  }

  messagesForSession(
    sessionId: string,
    limit: number = this.#cfg.reflectionMessageLimit,
  ): readonly ChatMessage[] {
    try {
      // 只取该会话消息(§6.1 沉淀):取最近 N 后正序还原。
      const rows = this.#db
        .prepare(`SELECT role, content FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`)
        .all(sessionId, limit);
      return rows
        .map((r) => ({ role: asString(r['role']) as ChatMessage['role'], content: asString(r['content']) }))
        .reverse();
    } catch (err) {
      this.#onError(err, 'messagesForSession');
      return [];
    }
  }

  addMemory(rec: MemoryInput): number {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return -1;
    const at = rec.createdAtMs ?? this.#now();
    // 归属规则与 InMemory 共用单一权威 helper(承 §5.3 / §5.3b);SQLite 列接受 NULL,故 `?? null`。
    const { subject, personId } = resolveAttribution(rec, this.#cfg);
    // 情景/语义分层(承 §5.9 缺口④):缺省 episodic;core ⟹ pinned(永不衰减,承 §5.4)。
    const { memoryKind, pinned: pinnedBool } = resolveMemoryKind(rec, this.#cfg);
    // 评分列初值(承 §5.5):importance 缺省配置初值、access_count=0、last_accessed=创建时。
    const importance = rec.importance ?? this.#cfg.initialImportance;
    const pinned = pinnedBool ? 1 : 0;
    // 未闭合话题标记(承 §7#2):缺省 0(非未了事);closed_at 写 NULL(尚未闭合)。
    const openThread = rec.openThread === true ? 1 : 0;
    try {
      // —— LSH 去重前置(承 §5.8 / §5.10 B2)——
      // ① 精确匹配快路径:规范化文本完全相等 → 只增计数/刷新近因,不重复建联想边(防 dedup 反复增重,§5.9 缺口①)。
      const existing = this.#db
        .prepare(`SELECT id FROM memories WHERE normalized_text = ?`)
        .get(normalized);
      if (existing !== undefined) {
        const existingId = asNumber(existing['id']);
        this.#db
          .prepare(`UPDATE memories SET hits = hits + 1, last_seen_at = ? WHERE id = ?`)
          .run(at, existingId);
        // 去重命中:返回被强化的那条 id(承 §5.6;不新建,补嵌时复用既有向量列)。
        return existingId;
      }
      // ② MinHash/LSH 候选 → 精确 Jaccard 终判:near-dup(>阈值)同样只增计数/刷新近因、不新建(§5.8)。
      const nearDupId = this.#findNearDuplicate(normalized);
      if (nearDupId !== undefined) {
        this.#db
          .prepare(`UPDATE memories SET hits = hits + 1, last_seen_at = ? WHERE id = ?`)
          .run(at, nearDupId);
        return nearDupId;
      }
      // 写新记忆 + 在同一事务内建实体索引/邻接边(原子:记忆与其联想网一起落库,§3.2)。
      this.#db.exec('BEGIN');
      try {
        const info = this.#db
          .prepare(
            `INSERT INTO memories(text, normalized_text, kind, created_at, last_seen_at, hits, source_session, subject, person_id, importance, access_count, last_accessed, pinned, open_thread, closed_at, memory_kind)
             VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, NULL, ?)`,
          )
          .run(
            rec.text,
            normalized,
            rec.kind ?? null,
            at,
            at,
            rec.sourceSession ?? null,
            subject,
            personId ?? null,
            importance,
            at,
            pinned,
            openThread,
            memoryKind,
          );
        const memoryId = asNumber(info.lastInsertRowid);
        // 联想扩散地基(承 §5.9 缺口①):建实体索引 + 与共享实体的旧记忆增建无向邻接边。
        linkEntitiesAndEdges(
          this.#db,
          memoryId,
          rec.text,
          personId,
          this.#cfg.normalize,
          this.#cfg.primaryPersonId,
        );
        this.#db.exec('COMMIT');
        // LSH 去重索引(承 §5.8 / §5.10 B2):commit 成功后把新记忆挂桶(派生内存索引,与库内一致)。
        this.#registerLsh(memoryId, normalized);
        // 返回新建记忆 id(承 §5.6:供编排层随后 setEmbedding 补嵌)。
        return memoryId;
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.#onError(err, 'addMemory');
    }
    // 写失败优雅降级:返回 -1(不抛,§3.2)。
    return -1;
  }

  /**
   * LSH 近重复查找(承 §5.8 / §5.10 B2;与 InMemory #findNearDuplicate 同一权威语义,零漂移):
   * 对新文本算 MinHash 签名 → 取 band 键 → 只在**同桶候选**里做**精确 Jaccard**,命中 `> lshJaccardThreshold`
   * 即视为近重复,返回被强化的既有记忆 id(不新建)。无候选/无命中 → undefined。
   * 候选按 id 升序遍历(确定性,最早写入优先);shingle/签名走 LRU 缓存(降本)。
   */
  #findNearDuplicate(normalized: string): number | undefined {
    const { shingles: querySh, signature } = this.#shingleCache.get(normalized);
    const candidateIds = new Set<number>();
    for (const key of lshBandKeys(signature, this.#cfg.lshBands)) {
      const bucket = this.#lshBuckets.get(key);
      if (bucket === undefined) continue;
      for (const id of bucket) candidateIds.add(id);
    }
    if (candidateIds.size === 0) return undefined;
    const ordered = [...candidateIds].sort((a, b) => a - b);
    for (const id of ordered) {
      const candSh = this.#shingleById.get(id);
      if (candSh === undefined) continue;
      if (jaccardSimilarity(querySh, candSh) > this.#cfg.lshJaccardThreshold) return id;
    }
    return undefined;
  }

  /** 把记忆挂入 LSH 桶 + 存其 shingle 集合(承 §5.10 B2;与 InMemory #registerLsh 同一规则,零漂移)。 */
  #registerLsh(memoryId: number, normalized: string): void {
    const { shingles: sh, signature } = this.#shingleCache.get(normalized);
    this.#shingleById.set(memoryId, sh);
    for (const key of lshBandKeys(signature, this.#cfg.lshBands)) {
      let bucket = this.#lshBuckets.get(key);
      if (bucket === undefined) {
        bucket = new Set<number>();
        this.#lshBuckets.set(key, bucket);
      }
      bucket.add(memoryId);
    }
  }

  /**
   * 联想扩散(承 §5.9 缺口① / §5.10 B1):**PPR(HippoRAG 式随机游走)取代固定跳 BFS**。
   * 从 query 命中的一阶种子出发,先 BFS 在邻接连通子图上圈定可达 `associationMaxHops` 跳内的节点集
   * (端侧只在子图上跑、节点数封顶 `pprMaxNodes`,几千节点单位数毫秒,承 §5.5 非阻塞),
   * 再在子图加权边上迭代 `r=(1−α)·M·r+α·s`,返回**每个非种子记忆 id → 其 PPR 稳态联想分**
   * (替代原 hop-decay 分;一阶种子不计入,同原 #spread)。强连接/近邻稳态分更高,自然处理多跳衰减。
   * 无边表/读失败/空种子/扩散关闭(maxHops<=0)→ 空(优雅降级,同现状,§3.2)。
   */
  #spread(seedIds: readonly number[]): Map<number, number> {
    const empty = new Map<number, number>();
    if (this.#cfg.associationMaxHops <= 0 || seedIds.length === 0) return empty;
    try {
      // —— BFS 圈定子图:从种子出发可达 associationMaxHops 跳内的节点,封顶 pprMaxNodes(近种子优先)——
      const neighborStmt = this.#db.prepare(
        // 无向:给定一端 id,取另一端 + 边权(a=? 取 b;b=? 取 a)。
        `SELECT b AS other, weight FROM memory_edges WHERE a = ?
         UNION ALL
         SELECT a AS other, weight FROM memory_edges WHERE b = ?`,
      );
      const cap = this.#cfg.pprMaxNodes;
      const visited = new Set<number>(seedIds); // 种子先入子图(BFS 到达序:种子在前)。
      // 子图加权边集(规范化为 a<b 去重;weight 取该对的累计共现权重)。
      const edgeWeight = new Map<string, PprEdge>();
      let frontier: number[] = [...new Set(seedIds)];
      for (let hop = 1; hop <= this.#cfg.associationMaxHops; hop++) {
        const next: number[] = [];
        for (const id of frontier) {
          const rows = neighborStmt.all(id, id) as { other: number; weight: number }[];
          for (const row of rows) {
            const other = asNumber(row.other);
            if (other === id) continue; // 自环跳过。
            const w = asNumber(row.weight);
            // 记录子图边(规范化无向键);PPR 转移矩阵据此构建。
            const a = Math.min(id, other);
            const b = Math.max(id, other);
            const key = `${a}:${b}`;
            if (!edgeWeight.has(key)) edgeWeight.set(key, { a, b, weight: w });
            if (visited.has(other)) continue;
            if (visited.size >= cap) continue; // 子图节点封顶:超出不再纳入(近种子优先,承端侧性能)。
            visited.add(other);
            next.push(other);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      // 只保留两端都在子图节点集内的边(封顶后悬边裁掉,保证 PPR 在封闭子图上跑)。
      const edges: PprEdge[] = [];
      for (const e of edgeWeight.values()) {
        if (visited.has(e.a) && visited.has(e.b)) edges.push(e);
      }
      // —— 在子图上跑 PPR 稳态分(单一权威纯函数,与 InMemory 零漂移)——
      return personalizedPageRank(seedIds, edges, this.#cfg);
    } catch (err) {
      this.#onError(err, 'spread');
      return new Map();
    }
  }

  /** 把一行 memories 记录映射为 MemoryRecord(读列兜底单一权威,recall/扩散候选共用,零漂移)。 */
  #rowToRecord(r: Record<string, unknown>): MemoryRecord {
    const lastSeenAtMs = asNumber(r['last_seen_at']);
    const importance =
      r['importance'] === null || r['importance'] === undefined
        ? this.#cfg.initialImportance
        : asNumber(r['importance']);
    const pinned = asNumber(r['pinned'] ?? 0) === 1;
    // 未闭合话题(承 §7#2):open_thread=1 且 closed_at 为空才算"当前未闭合";旧库 NULL 兜底为 false。
    const openThread =
      asNumber(r['open_thread'] ?? 0) === 1 &&
      (r['closed_at'] === null || r['closed_at'] === undefined);
    return {
      id: asNumber(r['id']),
      text: asString(r['text']),
      kind: r['kind'] === null || r['kind'] === undefined ? undefined : asString(r['kind']),
      // 情景/语义分层(承 §5.9 缺口④):v7 迁移后必有值;为稳健对旧 NULL 兜底为 episodic。
      memoryKind: normalizeKind(r['memory_kind']),
      createdAtMs: asNumber(r['created_at']),
      lastSeenAtMs,
      hits: asNumber(r['hits']),
      // subject 列在 v3 迁移后必有值;为稳健仍对 NULL 兜底为 'person'。
      subject: (r['subject'] === null || r['subject'] === undefined
        ? 'person'
        : asString(r['subject'])) as MemorySubject,
      personId:
        r['person_id'] === null || r['person_id'] === undefined
          ? undefined
          : asString(r['person_id']),
      importance,
      accessCount:
        r['access_count'] === null || r['access_count'] === undefined ? 0 : asNumber(r['access_count']),
      pinned,
      openThread,
    };
  }

  recall(
    query: string,
    limit: number = this.#cfg.recallLimit,
    pad?: Pad,
    kindOptions?: RecallKindOptions,
  ): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    // 按 kind 分路过滤集(承 §5.9 缺口④):空 / 省略 = 不过滤(全 kind),与 InMemory 同一语义。
    const kindFilter =
      kindOptions?.kinds !== undefined && kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(kindOptions.kinds)
        : undefined;
    try {
      // 不按主语过滤:一次覆盖 person+agent+shared,让上层同时拿到自述/事实/共同经历,防自相矛盾(§5.3 末条)。
      // SQL 只做 LIKE 候选过滤;归一/混合/排序在 JS 层用 config.ts 单一权威公式算(两后端零漂移,§5.5/§3.2)。
      // 取回 normalized_text 以在 JS 层用与 InMemory 同一规则复算关键词命中数(不依赖 SQL 端计数,免两套)。
      const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
      const params = tokens.map((t) => `%${t}%`);
      const firstRows = this.#db
        .prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE ${where}`)
        .all(...params) as Record<string, unknown>[];
      const now = this.#now();

      // —— 一阶候选(关键词命中)——
      // 每条候选的「关键词原始命中数 raw」与「记忆强度」入缺口③ 归一融合;关键词命中即在场(任一路在场即进池)。
      const candById = new Map<number, Cand>();
      for (const r of firstRows) {
        const record = this.#rowToRecord(r);
        // 按 kind 分路(承 §5.9 缺口④):不在过滤集内的候选直接跳过,不入候选池(也不当扩散种子)。
        if (kindFilter !== undefined && !kindFilter.has(record.memoryKind ?? 'episodic')) continue;
        const normalized = asString(r['normalized_text']);
        const rawHits = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
        candById.set(record.id, {
          record,
          // 一阶命中关键词必在场(present=true);情感按 pad 在场;强度恒在场;无联想/向量分(种子)。
          raw: this.#baseSignals(record, now, pad, { keyword: { present: true, value: rawHits } }),
        });
      }

      // —— 联想扩散 + 归一融合 + kind 调制 + 排序 + 检索即强化(承 §5.9 缺口①③④ / §5.5)——
      // 复用单一权威 finalize 流程(与 recallHybrid 共用,不另起第二套打分)。
      return this.#finalizeCandidates(candById, tokens, kindFilter, pad, now, limit);
    } catch (err) {
      this.#onError(err, 'recall');
      return [];
    }
  }

  /**
   * 构造一条候选的原始多路信号(单一权威,承 §5.5 / §5.9 缺口③):强度恒在场、情感按 pad 在场;
   * 关键词/联想/向量路由调用方按场景以 `overrides` 注入(缺省缺席)。两路召回(recall/hybrid)共用,杜绝漂移。
   */
  #baseSignals(
    record: MemoryRecord,
    now: number,
    pad: Pad | undefined,
    overrides: Partial<RawRecallSignals>,
  ): RawRecallSignals {
    return {
      keyword: { present: false, value: 0 },
      strength: {
        present: true,
        value: recallScore(
          record.importance ?? this.#cfg.initialImportance,
          decayFactor(record.lastSeenAtMs, now, record.pinned === true, this.#cfg),
        ),
      },
      emotion:
        pad !== undefined
          ? { present: true, value: emotionResonance(pad) }
          : { present: false, value: 0 },
      association: { present: false, value: 0 },
      vector: { present: false, value: 0 },
      ...overrides,
    };
  }

  /**
   * 候选池收尾(单一权威,承 §5.9 缺口①③④ / §5.5;recall 与 recallHybrid 共用,不另起第二套打分):
   * 1) 联想扩散:从已入池候选沿邻接图 1..maxHops 跳带入额外候选(带跳数衰减联想分);
   * 2) min-max 归一 + 可配权重融合(缺口③);3) kind 权重乘性调制(缺口④);
   * 4) 零信号门控(只丢全零)→ 融合分降序(同分 hits/id 兜底)→ 截断 limit;5) 检索即强化 top-N。
   * `tokens` 用于给联想带入的旁支复算其自身关键词命中(可能 0);为空数组则旁支关键词路恒缺席。
   */
  #finalizeCandidates(
    candById: Map<number, Cand>,
    tokens: readonly string[],
    kindFilter: Set<MemoryKind> | undefined,
    pad: Pad | undefined,
    now: number,
    limit: number,
    weights: RecallSignalWeights = this.#cfg.recallSignalWeights,
  ): readonly MemoryRecord[] {
    // —— 联想扩散(承 §5.9 缺口① / §5.10 B1):PPR 稳态分把多跳关联记忆带入候选 ——
    const seedIds = [...candById.keys()];
    const pprOf = this.#spread(seedIds);
    if (pprOf.size > 0) {
      // 批量取回联想候选记忆行(避免逐条查询;按 id 升序确定)。
      const ids = [...pprOf.keys()];
      const placeholders = ids.map(() => '?').join(', ');
      const assocRows = this.#db
        .prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];
      for (const r of assocRows) {
        const record = this.#rowToRecord(r);
        if (candById.has(record.id)) continue; // 已是一阶/向量命中,不重复。
        // 按 kind 分路(承 §5.9 缺口④):联想带入的旁支若不在过滤集内也跳过(分路一致)。
        if (kindFilter !== undefined && !kindFilter.has(record.memoryKind ?? 'episodic')) continue;
        const ppr = pprOf.get(record.id)!;
        const normalized = asString(r['normalized_text']);
        // 联想候选也算其自身关键词命中(可能 0):0 命中则关键词路缺席(不硬丢,靠联想/强度入池)。
        const rawHits = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
        candById.set(record.id, {
          record,
          raw: this.#baseSignals(record, now, pad, {
            keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
            // 联想分 = PPR 稳态分(承 §5.10 B1;强连接>弱连接、近>远;在候选集内 min-max 归一)。
            association: { present: true, value: ppr },
          }),
        });
      }
    }

    // —— 缺口③:候选集尺度 min-max 归一 + 可配权重融合(单一权威公式)——
    const cands = [...candById.values()];
    const fused = normalizeAndFuse(
      cands.map((c) => c.raw),
      weights,
    );
    // kind 权重调制(承 §5.9 缺口④):融合分 × 该候选 kind 权重(core>semantic>episodic 可配)。
    // 乘性调制不改变"谁能进池"(零信号仍为 0、非零仍非零),仅在融合后给分层不同分量(承 §5.5)。
    const scored = cands.map((c, i) => ({
      record: c.record,
      score: fused[i]! * memoryKindWeight(c.record.memoryKind, this.#cfg.memoryKindWeights),
    }));
    // 零信号门控只丢全零(承 §5.5:任一路在场即进池,不学 mem0 硬丢)。
    const kept = scored.filter((s) => s.score > 0);
    // 融合得分降序;同分按 hits / id 兜底,排序完全确定(与 InMemory 一致)。
    kept.sort((a, b) => b.score - a.score || b.record.hits - a.record.hits || b.record.id - a.record.id);
    const top = kept.slice(0, limit).map((c) => c.record);
    // 检索即强化:只对实际返回的 top-N 升 access_count/importance、更新 last_accessed(被想起→记得牢,§5.5)。
    this.#reinforce(top, now);
    return top;
  }

  /**
   * 检索即强化(承 §5.5):对返回的命中行升 access_count、按单一权威公式升 importance、更新 last_accessed。
   * 排序+截断之后施加,失败优雅降级不抛(§3.2),不拖垮召回返回。
   */
  #reinforce(records: readonly MemoryRecord[], now: number): void {
    if (records.length === 0) return;
    try {
      const stmt = this.#db.prepare(
        `UPDATE memories SET access_count = access_count + 1, importance = ?, last_accessed = ? WHERE id = ?`,
      );
      for (const r of records) {
        // importance 在 recall 映射时恒填充;`?? 初值` 仅满足可选类型,运行期不会触发。
        const base = r.importance ?? this.#cfg.initialImportance;
        stmt.run(reinforceImportance(base, this.#cfg), now, r.id);
      }
    } catch (err) {
      this.#onError(err, 'reinforce');
    }
  }

  recallWithContext(query: string, opts: RecallContextOptions = {}): RecallWithContext {
    // 复用 recall 的召回/排序/检索即强化(纯加法,不另起第二套打分);命中顺序即 recall 顺序。
    // kindOptions 透传(承 §5.9 缺口④:带上下文窗口的召回同样支持按分层分路)。
    const hits = this.recall(query, opts.limit, opts.pad, opts.kindOptions);
    const n = opts.windowSize ?? this.#cfg.contextWindowSize;
    // 取全局 messages 时序(ORDER BY id = 写入序 = 对话时序),JS 层就近锚定+切窗(与内存零漂移)。
    // 读失败优雅降级:窗口为空、不抛、召回主结果仍返回(§3.2)。
    let timeline: { createdAtMs: number; msg: ChatMessage }[] = [];
    try {
      const rows = this.#db
        .prepare(`SELECT created_at, role, content FROM messages ORDER BY id ASC`)
        .all();
      timeline = rows.map((r) => ({
        createdAtMs: asNumber(r['created_at']),
        msg: {
          role: asString(r['role']) as ChatMessage['role'],
          content: asString(r['content']),
        },
      }));
    } catch (err) {
      this.#onError(err, 'recallWithContext');
      timeline = [];
    }
    const timestamps = timeline.map((t) => t.createdAtMs);
    const total = timeline.length;
    const memories: RecalledMemory[] = [];
    // 跨命中去重:合并窗口按全局时序、同一条消息(按下标=稳定身份)只一次。
    const mergedIdx = new Set<number>();
    for (const record of hits) {
      const anchor = anchorIndex(timestamps, record.createdAtMs);
      const { start, end } = windowRange(anchor, total, n);
      const window: ChatMessage[] = [];
      for (let i = start; i < end; i++) {
        window.push(timeline[i]!.msg);
        mergedIdx.add(i);
      }
      memories.push({ record, contextWindow: window });
    }
    const merged: ChatMessage[] = [...mergedIdx].sort((a, b) => a - b).map((i) => timeline[i]!.msg);
    return { memories, mergedContext: merged };
  }

  openThreads(limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    try {
      // 只取"标记未闭合且未闭合"的记忆(承 §7#2);排序在 JS 层用与 recall 同一权威强度公式(零漂移)。
      const rows = this.#db
        .prepare(
          `SELECT id, text, normalized_text, kind, created_at, last_seen_at, hits, subject, person_id,
                  importance, access_count, last_accessed, pinned, open_thread, closed_at, memory_kind
           FROM memories
           WHERE open_thread = 1 AND closed_at IS NULL`,
        )
        .all();
      const now = this.#now();
      const candidates: { record: MemoryRecord; score: number }[] = [];
      for (const r of rows) {
        const lastSeenAtMs = asNumber(r['last_seen_at']);
        const importance =
          r['importance'] === null || r['importance'] === undefined
            ? this.#cfg.initialImportance
            : asNumber(r['importance']);
        const pinned = asNumber(r['pinned'] ?? 0) === 1;
        const record: MemoryRecord = {
          id: asNumber(r['id']),
          text: asString(r['text']),
          kind: r['kind'] === null || r['kind'] === undefined ? undefined : asString(r['kind']),
          memoryKind: normalizeKind(r['memory_kind']),
          createdAtMs: asNumber(r['created_at']),
          lastSeenAtMs,
          hits: asNumber(r['hits']),
          subject: (r['subject'] === null || r['subject'] === undefined
            ? 'person'
            : asString(r['subject'])) as MemorySubject,
          personId:
            r['person_id'] === null || r['person_id'] === undefined
              ? undefined
              : asString(r['person_id']),
          importance,
          accessCount:
            r['access_count'] === null || r['access_count'] === undefined ? 0 : asNumber(r['access_count']),
          pinned,
          openThread: true, // WHERE 已保证(open_thread=1 AND closed_at IS NULL)。
        };
        // 记忆强度分(承 §5.5):importance × decay;与 recall 同一权威公式(单一来源,两实现零漂移)。
        const score = recallScore(importance, decayFactor(lastSeenAtMs, now, pinned, this.#cfg));
        candidates.push({ record, score });
      }
      // 强度降序;同分按近因(last_seen)、再按 id 兜底,排序完全确定(与 InMemory 一致)。
      candidates.sort(
        (a, b) =>
          b.score - a.score ||
          b.record.lastSeenAtMs - a.record.lastSeenAtMs ||
          b.record.id - a.record.id,
      );
      // 决策 2:巡检不触发检索即强化(不调用 #reinforce),免待办虚高强度污染 recall 排序。
      return candidates.slice(0, limit).map((c) => c.record);
    } catch (err) {
      this.#onError(err, 'openThreads');
      return [];
    }
  }

  closeThread(id: number): void {
    try {
      // 幂等:仅闭合尚未闭合者(closed_at IS NULL),已闭合 / 未知 id 命中 0 行、无副作用(承 §7#2 决策 3)。
      this.#db
        .prepare(`UPDATE memories SET closed_at = ? WHERE id = ? AND closed_at IS NULL`)
        .run(this.#now(), id);
    } catch (err) {
      this.#onError(err, 'closeThread');
    }
  }

  setEmbedding(id: number, vector: readonly number[]): void {
    if (vector.length === 0) return; // 空向量不写(无意义;保持该行 embedding 为 NULL,仍待补嵌)。
    try {
      // 写 Float32 BLOB(不透明存储,承 §5.6 接缝 7 / §5.9 接缝预留⑤) + 维度;对不存在 id 命中 0 行、幂等不抛。
      this.#db
        .prepare(`UPDATE memories SET embedding = ?, embedding_dim = ? WHERE id = ?`)
        .run(encodeEmbedding(vector), vector.length, id);
    } catch (err) {
      this.#onError(err, 'setEmbedding');
    }
  }

  recallByVector(
    vector: readonly number[],
    limit: number = this.#cfg.recallLimit,
    opts: RecallByVectorOptions = {},
  ): readonly MemoryRecord[] {
    const ranked = this.#vectorKnn(vector, opts.kindOptions);
    // 截断 limit 后映射为记录(ranked 已按 cosine 降序);维度不符的行已在 #vectorKnn 跳过。
    return ranked.slice(0, limit).map((c) => c.record);
  }

  /**
   * 同步向量 KNN 内核(承 §5.6 接缝 7):取**有 embedding** 的行(候选封顶 `vectorKnnCandidateCap`),
   * JS 暴力 cosine,**维度不一致跳过**(不抛),按相似度降序(同分 id 兜底)返回 `{record, sim}`。
   * 不卡事件循环靠候选封顶(承 §5.5 末「🔴 非阻塞召回」)。供 recallByVector / recallHybrid 共用。
   */
  #vectorKnn(
    vector: readonly number[],
    kindOptions: RecallKindOptions | undefined,
    cap: number = this.#cfg.vectorKnnCandidateCap,
  ): { record: MemoryRecord; sim: number }[] {
    if (vector.length === 0) return [];
    const kindFilter =
      kindOptions?.kinds !== undefined && kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(kindOptions.kinds)
        : undefined;
    try {
      // 候选封顶:只取有 embedding 的行(NULL 即未嵌入,不参与 KNN);按近因优先(last_seen 降序)取前 cap。
      // 取行同时带 embedding/embedding_dim 以本地算 cosine(端侧单用户量级,暴力即可,§5.6)。
      // weighted 混合召回会传更大 cap 做"融合前 over-fetch"(融合后再按 vectorKnnCandidateCap 收口)。
      const rows = this.#db
        .prepare(
          `SELECT ${MEMORY_COLS}, embedding, embedding_dim FROM memories
           WHERE embedding IS NOT NULL
           ORDER BY last_seen_at DESC, id DESC
           LIMIT ?`,
        )
        .all(cap) as Record<string, unknown>[];
      const out: { record: MemoryRecord; sim: number }[] = [];
      for (const r of rows) {
        const record = this.#rowToRecord(r);
        if (kindFilter !== undefined && !kindFilter.has(record.memoryKind ?? 'episodic')) continue;
        // 维度不一致直接跳过(不抛,承硬约束);dim 列与实际字节双保险。
        const dim = r['embedding_dim'] === null || r['embedding_dim'] === undefined ? 0 : asNumber(r['embedding_dim']);
        if (dim !== vector.length) continue;
        const raw = r['embedding'];
        if (!(raw instanceof Uint8Array)) continue;
        const memVec = decodeEmbedding(raw);
        if (memVec.length !== vector.length) continue; // 字节与 dim 不符也跳过。
        out.push({ record, sim: cosineSimilarity(vector, memVec) });
      }
      // 相似度降序;同分按 id 兜底,排序完全确定。
      out.sort((a, b) => b.sim - a.sim || b.record.id - a.record.id);
      return out;
    } catch (err) {
      this.#onError(err, 'recallByVector');
      return [];
    }
  }

  recallHybrid(query: string, opts: RecallHybridOptions = {}): readonly MemoryRecord[] {
    const limit = opts.limit ?? this.#cfg.recallLimit;
    // 无 queryVector → 关键词快路径,逐字复用 recall(承 §5.5 末「🔴 非阻塞召回」快路径下限)。
    if (opts.queryVector === undefined || opts.queryVector.length === 0) {
      return this.recall(query, limit, opts.pad, opts.kindOptions);
    }
    const tokens = tokenize(query, this.#cfg.normalize);
    const kindFilter =
      opts.kindOptions?.kinds !== undefined && opts.kindOptions.kinds.length > 0
        ? new Set<MemoryKind>(opts.kindOptions.kinds)
        : undefined;
    try {
      const now = this.#now();
      const pad = opts.pad;
      const queryVector = opts.queryVector;

      // —— 关键词路:候选 + 原始命中数(融合前 over-fetch,不预截断)——
      const recordById = new Map<number, MemoryRecord>();
      const keywordHitById = new Map<number, number>();
      if (tokens.length > 0) {
        const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
        const params = tokens.map((t) => `%${t}%`);
        const rows = this.#db
          .prepare(`SELECT ${MEMORY_COLS} FROM memories WHERE ${where}`)
          .all(...params) as Record<string, unknown>[];
        for (const r of rows) {
          const record = this.#rowToRecord(r);
          if (kindFilter !== undefined && !kindFilter.has(record.memoryKind ?? 'episodic')) continue;
          const normalized = asString(r['normalized_text']);
          const rawHits = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
          recordById.set(record.id, record);
          keywordHitById.set(record.id, rawHits);
        }
      }

      // —— 向量路:KNN(cosine 降序;维度不符已跳过)。融合前 over-fetch:cap 放大,融合后才收口 ——
      const overFetchCap = this.#cfg.fusionMode === 'weighted'
        ? Number.MAX_SAFE_INTEGER // weighted:先全取,融合后按 vectorKnnCandidateCap 收口(承用户拍板)。
        : this.#cfg.vectorKnnCandidateCap;
      const vectorHits = this.#vectorKnn(queryVector, opts.kindOptions, overFetchCap);
      const simById = new Map<number, number>();
      const vectorRanked: number[] = [];
      for (const v of vectorHits) {
        simById.set(v.record.id, v.sim);
        vectorRanked.push(v.record.id);
        if (!recordById.has(v.record.id)) recordById.set(v.record.id, v.record);
      }

      // —— 候选池:关键词路 ∪ 向量路并集都入池(任一路在场即进池,承 §5.5;不硬门控丢项)——
      const candById = new Map<number, Cand>();
      const allIds = new Set<number>([...keywordHitById.keys(), ...simById.keys()]);
      if (this.#cfg.fusionMode === 'rrf') {
        // —— 备选:RRF 按名次融合(承 §5.9;默认不走)——
        const keywordRanked = [...keywordHitById.entries()]
          .sort((a, b) => b[1] - a[1] || a[0] - b[0])
          .map(([id]) => id);
        const rrf = reciprocalRankFusion([keywordRanked, vectorRanked], this.#cfg.rrfK);
        const rrfMax = 2 / (this.#cfg.rrfK + 1); // 两路、最佳名次的理论上界,归一到 [0,1]。
        for (const id of allIds) {
          const record = recordById.get(id);
          if (record === undefined) continue;
          const rawHits = keywordHitById.get(id) ?? 0;
          const rrfScore = rrf.get(id) ?? 0;
          candById.set(id, {
            record,
            raw: this.#baseSignals(record, now, pad, {
              keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
              vector: { present: true, value: rrfMax > 0 ? Math.min(rrfScore / rrfMax, 1) : 0 },
            }),
          });
        }
        return this.#finalizeCandidates(candById, tokens, kindFilter, pad, now, limit);
      }

      // —— 默认 weighted:向量相似度当又一路 min-max 归一信号,折进既有加性归一(参考 Nexus 范式)——
      // 关键词路 = 原始命中数;向量路 = 原始 cosine(min-max 归一在 normalizeAndFuse 内做);两路缺席则该路不在场。
      for (const id of allIds) {
        const record = recordById.get(id);
        if (record === undefined) continue;
        const rawHits = keywordHitById.get(id) ?? 0;
        const sim = simById.get(id);
        candById.set(id, {
          record,
          raw: this.#baseSignals(record, now, pad, {
            keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
            // 向量路:原始相似度入场(min-max 归一与加权融合在 normalizeAndFuse 用 hybridSignalWeights 做)。
            vector: sim !== undefined ? { present: true, value: sim } : { present: false, value: 0 },
          }),
        });
      }
      // 融合前 over-fetch、融合后才按 vectorKnnCandidateCap 收口:把候选池(并集)截断到 cap 再 finalize(承用户拍板)。
      const capped = this.#capCandidates(candById, this.#cfg.vectorKnnCandidateCap);
      // weighted 融合用向量偏重的 hybridSignalWeights(默认 vec 0.6 / kw 0.4);其余复用单一权威 finalize。
      return this.#finalizeCandidates(capped, tokens, kindFilter, pad, now, limit, this.#cfg.hybridSignalWeights);
    } catch (err) {
      this.#onError(err, 'recallHybrid');
      return [];
    }
  }

  /**
   * 候选池收口(承用户拍板「融合后才按 vectorKnnCandidateCap 封顶」):按候选自身向量/关键词强度粗排取前 cap,
   * 控制后续联想扩散/归一融合的工作集规模(不卡事件循环,承 §5.5 末「🔴 非阻塞召回」)。
   * 粗排键:向量分(无则 0)→ 关键词分 → id;只为限规模,精排仍由 #finalizeCandidates 的归一融合决定。
   */
  #capCandidates(candById: Map<number, Cand>, cap: number): Map<number, Cand> {
    if (candById.size <= cap) return candById;
    const ranked = [...candById.values()].sort((a, b) => {
      const av = a.raw.vector.present ? a.raw.vector.value : 0;
      const bv = b.raw.vector.present ? b.raw.vector.value : 0;
      const ak = a.raw.keyword.present ? a.raw.keyword.value : 0;
      const bk = b.raw.keyword.present ? b.raw.keyword.value : 0;
      return bv - av || bk - ak || a.record.id - b.record.id;
    });
    const out = new Map<number, Cand>();
    for (const c of ranked.slice(0, cap)) out.set(c.record.id, c);
    return out;
  }

  memoriesNeedingEmbedding(
    limit: number = this.#cfg.recallLimit,
  ): readonly { readonly id: number; readonly text: string }[] {
    try {
      // embedding 为 NULL 即尚未嵌入(承 §5.6「写侧 embedding 走后台」);按 id 升序确定(先写先补)。
      const rows = this.#db
        .prepare(`SELECT id, text FROM memories WHERE embedding IS NULL ORDER BY id ASC LIMIT ?`)
        .all(limit) as Record<string, unknown>[];
      return rows.map((r) => ({ id: asNumber(r['id']), text: asString(r['text']) }));
    } catch (err) {
      this.#onError(err, 'memoriesNeedingEmbedding');
      return [];
    }
  }

  /**
   * 读 `people.relationship_state` JSON → `{closeness, updatedAtMs}`(承 §6/§5.3b);
   * 无行 / 无 JSON / 解析失败 / 字段缺失均返回 null(由调用方落到 `initialCloseness`,容错不抛)。
   * 存储字段名 `closenessUpdatedAtMs`,读时映射为内部 `updatedAtMs`(JSON 形状单一权威,与 InMemory 一致)。
   */
  #readRel(personId: string): { closeness: number; updatedAtMs: number } | null {
    const row = this.#db
      .prepare(`SELECT relationship_state FROM people WHERE person_id = ?`)
      .get(personId);
    if (row === undefined) return null;
    const raw = row['relationship_state'];
    if (raw === null || raw === undefined) return null;
    try {
      const parsed = JSON.parse(asString(raw)) as Record<string, unknown>;
      const closeness = parsed['closeness'];
      const updatedAtMs = parsed['closenessUpdatedAtMs'];
      if (typeof closeness !== 'number' || typeof updatedAtMs !== 'number') return null;
      return { closeness, updatedAtMs };
    } catch {
      return null;
    }
  }

  getCloseness(personId: string): number {
    return this.getClosenessAt(personId, this.#now());
  }

  getClosenessAt(personId: string, atMs: number): number {
    try {
      const rel = this.#readRel(personId);
      // 无记录(含未知 person / 容错降级):返回配置初值(陌生起步,承 §6)。读不写回(§5.5)。
      if (rel === null) return this.#cfg.initialCloseness;
      return decayCloseness(rel.closeness, rel.updatedAtMs, atMs, this.#cfg);
    } catch (err) {
      this.#onError(err, 'getClosenessAt');
      return this.#cfg.initialCloseness;
    }
  }

  bumpCloseness(personId: string, valencePos: number, atMs: number): number {
    try {
      // 先取衰减后当前值,再按正向程度渐近抬升(单一权威公式,承 §6/§2.3)。
      const cur = this.getClosenessAt(personId, atMs);
      const next = bumpClosenessValue(cur, valencePos, this.#cfg);
      const json = JSON.stringify({ closeness: next, closenessUpdatedAtMs: atMs });
      // 写回 relationship_state;未知 personId 命中 0 行,幂等不抛(承 §3.2)。
      this.#db.prepare(`UPDATE people SET relationship_state = ? WHERE person_id = ?`).run(json, personId);
      return next;
    } catch (err) {
      this.#onError(err, 'bumpCloseness');
      return this.#cfg.initialCloseness;
    }
  }

  getState(key: string): string | undefined {
    try {
      const row = this.#db.prepare(`SELECT value FROM kv_state WHERE key = ?`).get(key);
      return row === undefined ? undefined : asString(row['value']);
    } catch (err) {
      this.#onError(err, 'getState');
      return undefined;
    }
  }

  setState(key: string, value: string): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO kv_state(key, value) VALUES(?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, value);
    } catch (err) {
      this.#onError(err, 'setState');
    }
  }

  close(): void {
    try {
      this.#db.close();
    } catch (err) {
      this.#onError(err, 'close');
    }
  }
}
