import { DatabaseSync } from 'node:sqlite';
import type {
  ChatMessage,
  MemoryInput,
  MemoryRecord,
  MemoryStore,
  MemorySubject,
  Person,
  StoredMessage,
} from './types';
import {
  makePrimaryPerson,
  resolveAttribution,
  resolveMemoryConfig,
  tokenize,
  type MemoryConfig,
} from './config';

/** 当前代码支持的记忆库 schema 版本。每次破坏性/累加性变更 +1 并新增一条迁移。 */
export const CURRENT_SCHEMA_VERSION = 3;

/**
 * 迁移步骤上下文:主用户花名册条目经此注入(承 §3.2 行为即配置),
 * 杜绝把主用户身份/不变式硬编码进迁移 SQL(决策 5);Person 由 makePrimaryPerson 单一构造。
 */
interface MigrationContext {
  readonly primaryPerson: Person;
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
    const ctx: MigrationContext = { primaryPerson: makePrimaryPerson(this.#cfg) };
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

  addMemory(rec: MemoryInput): void {
    const normalized = this.#cfg.normalize(rec.text);
    if (normalized.length === 0) return;
    const at = rec.createdAtMs ?? this.#now();
    // 归属规则与 InMemory 共用单一权威 helper(承 §5.3 / §5.3b);SQLite 列接受 NULL,故 `?? null`。
    const { subject, personId } = resolveAttribution(rec, this.#cfg);
    try {
      this.#db
        .prepare(
          `INSERT INTO memories(text, normalized_text, kind, created_at, last_seen_at, hits, source_session, subject, person_id)
           VALUES(?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT(normalized_text) DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at`,
        )
        .run(rec.text, normalized, rec.kind ?? null, at, at, rec.sourceSession ?? null, subject, personId ?? null);
    } catch (err) {
      this.#onError(err, 'addMemory');
    }
  }

  recall(query: string, limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    try {
      // 不按主语过滤:一次覆盖 person+agent+shared,让上层同时拿到自述/事实/共同经历,防自相矛盾(§5.3 末条)。
      const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
      const params = tokens.map((t) => `%${t}%`);
      const rows = this.#db
        .prepare(
          `SELECT id, text, kind, created_at, last_seen_at, hits, subject, person_id FROM memories
           WHERE ${where}
           ORDER BY last_seen_at DESC, hits DESC, id DESC
           LIMIT ?`,
        )
        .all(...params, limit);
      return rows.map((r) => ({
        id: asNumber(r['id']),
        text: asString(r['text']),
        kind: r['kind'] === null || r['kind'] === undefined ? undefined : asString(r['kind']),
        createdAtMs: asNumber(r['created_at']),
        lastSeenAtMs: asNumber(r['last_seen_at']),
        hits: asNumber(r['hits']),
        // subject 列在 v3 迁移后必有值;为稳健仍对 NULL 兜底为 'person'。
        subject: (r['subject'] === null || r['subject'] === undefined
          ? 'person'
          : asString(r['subject'])) as MemorySubject,
        personId:
          r['person_id'] === null || r['person_id'] === undefined ? undefined : asString(r['person_id']),
      }));
    } catch (err) {
      this.#onError(err, 'recall');
      return [];
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
