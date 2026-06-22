import { DatabaseSync } from 'node:sqlite';
import type { ChatMessage, MemoryInput, MemoryRecord, MemoryStore, StoredMessage } from './types';
import { resolveMemoryConfig, tokenize, type MemoryConfig } from './config';

/** 当前代码支持的记忆库 schema 版本。每次破坏性/累加性变更 +1 并新增一条迁移。 */
export const CURRENT_SCHEMA_VERSION = 2;

/**
 * 顺序迁移:版本号 → 升级到该版本的步骤。用 IF NOT EXISTS 保持幂等,
 * 让"已有数据的旧库"被安全纳管而不重建(承 §3.2 数据迁移纪律)。
 */
const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
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

    this.#db.exec('BEGIN');
    try {
      for (let v = current + 1; v <= CURRENT_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step === undefined) throw new Error(`缺少 schema v${v} 的迁移步骤`);
        step(this.#db);
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
    try {
      this.#db
        .prepare(
          `INSERT INTO memories(text, normalized_text, kind, created_at, last_seen_at, hits, source_session)
           VALUES(?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(normalized_text) DO UPDATE SET hits = hits + 1, last_seen_at = excluded.last_seen_at`,
        )
        .run(rec.text, normalized, rec.kind ?? null, at, at, rec.sourceSession ?? null);
    } catch (err) {
      this.#onError(err, 'addMemory');
    }
  }

  recall(query: string, limit: number = this.#cfg.recallLimit): readonly MemoryRecord[] {
    const tokens = tokenize(query, this.#cfg.normalize);
    if (tokens.length === 0) return [];
    try {
      const where = tokens.map(() => `normalized_text LIKE ?`).join(' OR ');
      const params = tokens.map((t) => `%${t}%`);
      const rows = this.#db
        .prepare(
          `SELECT id, text, kind, created_at, last_seen_at, hits FROM memories
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
