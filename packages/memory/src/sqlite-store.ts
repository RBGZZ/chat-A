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
  keywordScore,
  makePrimaryPerson,
  mixedRecallScore,
  recallScore,
  reinforceImportance,
  resolveAttribution,
  resolveMemoryConfig,
  tokenize,
  windowRange,
  type MemoryConfig,
  type RecallSignal,
} from './config';

/** 当前代码支持的记忆库 schema 版本。每次破坏性/累加性变更 +1 并新增一条迁移。 */
export const CURRENT_SCHEMA_VERSION = 4;

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
};

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
    try {
      this.#db
        .prepare(
          `INSERT INTO memories(text, normalized_text, kind, created_at, last_seen_at, hits, source_session, subject, person_id, importance, access_count, last_accessed, pinned)
           VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(normalized_text) DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at`,
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
        );
    } catch (err) {
      this.#onError(err, 'addMemory');
    }
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
      const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
      const params = tokens.map((t) => `%${t}%`);
      const rows = this.#db
        .prepare(
          `SELECT id, text, normalized_text, kind, created_at, last_seen_at, hits, subject, person_id,
                  importance, access_count, last_accessed, pinned
           FROM memories
           WHERE ${where}`,
        )
        .all(...params);
      const now = this.#now();
      // 读列兜底:旧库残留 NULL 时给安全默认(importance→初值、access_count→0、pinned→false、last_accessed→last_seen)。
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
          // subject 列在 v3 迁移后必有值;为稳健仍对 NULL 兜底为 'person'。
          subject: (r['subject'] === null || r['subject'] === undefined
            ? 'person'
            : asString(r['subject'])) as MemorySubject,
          personId:
            r['person_id'] === null || r['person_id'] === undefined
              ? undefined
              : asString(r['person_id']),
          importance,
          accessCount: r['access_count'] === null || r['access_count'] === undefined ? 0 : asNumber(r['access_count']),
          pinned,
        };
        // 关键词原始分:命中查询 token 去重数(与 InMemory 同 normalized includes 规则,零漂移)。
        const normalized = asString(r['normalized_text']);
        const raw = tokens.reduce((n, t) => (normalized.includes(t) ? n + 1 : n), 0);
        // 混合归一得分(承 §5.5):关键词归一 + 记忆强度(importance×decay)+ 可选情感共振;
        // 衰减/强度用强化前的值算,保证本次返回排序确定(强化只影响后续召回,§5.5 决策 3)。
        const signals: RecallSignal[] = [
          { present: true, value: keywordScore(raw, tokens.length, this.#cfg) },
          { present: true, value: recallScore(importance, decayFactor(lastSeenAtMs, now, pinned, this.#cfg)) },
        ];
        // 情感共振仅当调用方传入 PAD 时在场(默认不启用,§5.5);记忆侧 emotion 本期缺省按中性。
        if (pad !== undefined) signals.push({ present: true, value: emotionResonance(pad) });
        const score = mixedRecallScore(signals);
        if (score <= 0) continue; // 零信号门控:全部在场信号为 0 才丢(只对零信号生效,§5.5)。
        candidates.push({ record, score });
      }
      // 混合得分降序;同分按 hits / id 兜底,排序完全确定(与 InMemory 一致)。
      candidates.sort(
        (a, b) =>
          b.score - a.score || b.record.hits - a.record.hits || b.record.id - a.record.id,
      );
      const top = candidates.slice(0, limit).map((c) => c.record);
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
