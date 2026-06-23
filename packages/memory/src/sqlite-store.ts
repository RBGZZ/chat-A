import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  MemoryInput,
  MemoryRecord,
  MemoryStore,
  MemorySubject,
  Pad,
  Person,
  RecallContextOptions,
  RecallWithContext,
  RecalledMemory,
  StoredMessage,
} from './types';
import {
  anchorIndex,
  decayFactor,
  emotionResonance,
  entityKeys,
  hopDecay,
  makePrimaryPerson,
  normalizeAndFuse,
  recallScore,
  reinforceImportance,
  resolveAttribution,
  resolveMemoryConfig,
  tokenize,
  windowRange,
  type MemoryConfig,
  type RawRecallSignals,
} from './config';

/** 当前代码支持的记忆库 schema 版本。每次破坏性/累加性变更 +1 并新增一条迁移。 */
export const CURRENT_SCHEMA_VERSION = 6;

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
 * SQLite 记忆实现(node:sqlite,单文件真相源,§8.1)。
 * 写路径 ADD+去重(ON CONFLICT 增计数);关键词召回(token/LIKE,P1);schema 版本化+迁移。
 * 读失败优雅降级为空(不拖垮主对话,§3.2)。
 */
export class SqliteMemoryStore implements MemoryStore {
  readonly #db: DatabaseSync;
  readonly #cfg: MemoryConfig;
  readonly #now: () => number;
  readonly #onError: (err: unknown, op: string) => void;

  constructor(opts: SqliteMemoryStoreOptions) {
    this.#cfg = resolveMemoryConfig(opts.config);
    this.#now = opts.now ?? Date.now;
    this.#onError = opts.onError ?? ((err, op) => console.error(`[memory] ${op} 失败`, err));
    this.#db = new DatabaseSync(opts.path);
    try {
      this.#db.exec('PRAGMA journal_mode=WAL;');
      this.#migrate();
    } catch (err) {
      // 初始化失败(如 schema 版本过高)必须关句柄,否则 Windows 会一直锁住 DB 文件。
      this.#db.close();
      throw err;
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

  addMemory(rec: MemoryInput): void {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return;
    const at = rec.createdAtMs ?? this.#now();
    // 归属规则与 InMemory 共用单一权威 helper(承 §5.3 / §5.3b);SQLite 列接受 NULL,故 `?? null`。
    const { subject, personId } = resolveAttribution(rec, this.#cfg);
    // 评分列初值(承 §5.5):importance 缺省配置初值、access_count=0、last_accessed=创建时、pinned 缺省 0。
    const importance = rec.importance ?? this.#cfg.initialImportance;
    const pinned = rec.pinned === true ? 1 : 0;
    // 未闭合话题标记(承 §7#2):缺省 0(非未了事);closed_at 写 NULL(尚未闭合)。
    const openThread = rec.openThread === true ? 1 : 0;
    try {
      // 去重:已存在等价文本则只增计数/刷新近因,不重复建联想边(防 dedup 反复增重,§5.9 缺口①)。
      const existing = this.#db
        .prepare(`SELECT id FROM memories WHERE normalized_text = ?`)
        .get(normalized);
      if (existing !== undefined) {
        this.#db
          .prepare(`UPDATE memories SET hits = hits + 1, last_seen_at = ? WHERE id = ?`)
          .run(at, asNumber(existing['id']));
        return;
      }
      // 写新记忆 + 在同一事务内建实体索引/邻接边(原子:记忆与其联想网一起落库,§3.2)。
      this.#db.exec('BEGIN');
      try {
        const info = this.#db
          .prepare(
            `INSERT INTO memories(text, normalized_text, kind, created_at, last_seen_at, hits, source_session, subject, person_id, importance, access_count, last_accessed, pinned, open_thread, closed_at)
             VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?, NULL)`,
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
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    } catch (err) {
      this.#onError(err, 'addMemory');
    }
  }

  /**
   * 沿邻接图扩散(承 §5.9 缺口①):从一阶命中记忆 id 出发做 1..maxHops 跳广度遍历,
   * 返回每个被联想到的额外记忆 id → 其最小跳数(供按跳数衰减算联想分)。
   * 一阶命中本身(hop=0)不计入返回(它们已在候选池)。无边表/读失败优雅降级为空(§3.2)。
   */
  #spread(seedIds: readonly number[], maxHops: number): Map<number, number> {
    const hopOf = new Map<number, number>();
    if (maxHops <= 0 || seedIds.length === 0) return hopOf;
    try {
      const seed = new Set(seedIds);
      const neighborStmt = this.#db.prepare(
        // 无向:给定一端 id,取另一端(a=? 取 b;b=? 取 a)。
        `SELECT b AS other FROM memory_edges WHERE a = ?
         UNION
         SELECT a AS other FROM memory_edges WHERE b = ?`,
      );
      let frontier: number[] = [...seedIds];
      for (let hop = 1; hop <= maxHops; hop++) {
        const next: number[] = [];
        for (const id of frontier) {
          const rows = neighborStmt.all(id, id) as { other: number }[];
          for (const row of rows) {
            const other = asNumber(row.other);
            if (seed.has(other)) continue; // 一阶命中不算联想候选。
            if (hopOf.has(other)) continue; // 已记录更小跳数(BFS 先到即最小)。
            hopOf.set(other, hop);
            next.push(other);
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
    } catch (err) {
      this.#onError(err, 'spread');
      return new Map();
    }
    return hopOf;
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
  ): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    try {
      // 不按主语过滤:一次覆盖 person+agent+shared,让上层同时拿到自述/事实/共同经历,防自相矛盾(§5.3 末条)。
      // SQL 只做 LIKE 候选过滤;归一/混合/排序在 JS 层用 config.ts 单一权威公式算(两后端零漂移,§5.5/§3.2)。
      // 取回 normalized_text 以在 JS 层用与 InMemory 同一规则复算关键词命中数(不依赖 SQL 端计数,免两套)。
      const cols = `id, text, normalized_text, kind, created_at, last_seen_at, hits, subject, person_id,
                    importance, access_count, last_accessed, pinned, open_thread, closed_at`;
      const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
      const params = tokens.map((t) => `%${t}%`);
      const firstRows = this.#db
        .prepare(`SELECT ${cols} FROM memories WHERE ${where}`)
        .all(...params) as Record<string, unknown>[];
      const now = this.#now();

      // —— 一阶候选(关键词命中)——
      // 每条候选的「关键词原始命中数 raw」与「记忆强度」入缺口③ 归一融合;关键词命中即在场(任一路在场即进池)。
      type Cand = {
        record: MemoryRecord;
        raw: RawRecallSignals;
      };
      const candById = new Map<number, Cand>();
      for (const r of firstRows) {
        const record = this.#rowToRecord(r);
        const normalized = asString(r['normalized_text']);
        const rawHits = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
        candById.set(record.id, {
          record,
          raw: {
            keyword: { present: true, value: rawHits },
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
            // 一阶命中不带联想分(它们是种子,不是被联想到的,§5.9 缺口①)。
            association: { present: false, value: 0 },
          },
        });
      }

      // —— 联想扩散(承 §5.9 缺口①):从一阶命中沿邻接图 1..maxHops 跳带入额外候选 ——
      const seedIds = [...candById.keys()];
      const hopOf = this.#spread(seedIds, this.#cfg.associationMaxHops);
      if (hopOf.size > 0) {
        // 批量取回联想候选记忆行(避免逐条查询;按 id 升序确定)。
        const ids = [...hopOf.keys()];
        const placeholders = ids.map(() => '?').join(', ');
        const assocRows = this.#db
          .prepare(`SELECT ${cols} FROM memories WHERE id IN (${placeholders})`)
          .all(...ids) as Record<string, unknown>[];
        for (const r of assocRows) {
          const record = this.#rowToRecord(r);
          if (candById.has(record.id)) continue; // 已是一阶命中,不重复。
          const hop = hopOf.get(record.id)!;
          const normalized = asString(r['normalized_text']);
          // 联想候选也算其自身关键词命中(可能 0):0 命中则关键词路缺席(不硬丢,靠联想/强度入池)。
          const rawHits = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
          candById.set(record.id, {
            record,
            raw: {
              keyword: rawHits > 0 ? { present: true, value: rawHits } : { present: false, value: 0 },
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
              // 联想分按跳数衰减(hop=1→decay、hop=2→decay²;承 §5.9 缺口①)。
              association: {
                present: true,
                value: hopDecay(hop, this.#cfg.associationHopDecay),
              },
            },
          });
        }
      }

      // —— 缺口③:候选集尺度 min-max 归一 + 可配权重融合(单一权威公式)——
      const cands = [...candById.values()];
      const fused = normalizeAndFuse(
        cands.map((c) => c.raw),
        this.#cfg.recallSignalWeights,
      );
      const scored = cands.map((c, i) => ({ record: c.record, score: fused[i]! }));
      // 零信号门控只丢全零(承 §5.5:任一路在场即进池,不学 mem0 硬丢)。
      const kept = scored.filter((s) => s.score > 0);
      // 融合得分降序;同分按 hits / id 兜底,排序完全确定(与 InMemory 一致)。
      kept.sort((a, b) => b.score - a.score || b.record.hits - a.record.hits || b.record.id - a.record.id);
      const top = kept.slice(0, limit).map((c) => c.record);
      // 检索即强化:只对实际返回的 top-N 升 access_count/importance、更新 last_accessed(被想起→记得牢,§5.5)。
      this.#reinforce(top, now);
      return top;
    } catch (err) {
      this.#onError(err, 'recall');
      return [];
    }
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
    const hits = this.recall(query, opts.limit, opts.pad);
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
                  importance, access_count, last_accessed, pinned, open_thread, closed_at
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
