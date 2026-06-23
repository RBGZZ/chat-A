import { DatabaseSync } from 'node:sqlite';
import type { DecisionTrace, DecisionTraceSink } from './decision-trace';
import { NoopDecisionTraceSink } from './decision-trace';

/** 当前决策 trace 库 schema 版本。破坏性/累加性变更 +1 并新增迁移。 */
export const CURRENT_TRACE_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS decision_traces(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        correlation_id TEXT NOT NULL,
        trace_id TEXT,
        span_id TEXT,
        session_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        user_text TEXT NOT NULL,
        recalled TEXT NOT NULL,
        emotion TEXT NOT NULL,
        pad TEXT,
        assertiveness REAL NOT NULL,
        stance_notions TEXT NOT NULL,
        system TEXT NOT NULL,
        messages TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reply TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_traces_correlation ON decision_traces(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_traces_session ON decision_traces(session_id);
    `);
  },
};

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}

export interface SqliteDecisionTraceSinkOptions {
  /** 库文件路径;':memory:' 为内存库(测试用)。独立于记忆库。 */
  readonly path: string;
  /** 错误回调(§8.1 error 层);默认 console.error。降级时记录而非抛出。 */
  readonly onError?: (err: unknown, op: string) => void;
}

/**
 * 决策 trace 落 SQLite(node:sqlite,独立库,§8.1 真相源、无条件全量)。
 * record 内部失败自吞降级——可观测性绝不打断回合(§3.2)。schema 版本化 + 迁移(§3.2)。
 */
export class SqliteDecisionTraceSink implements DecisionTraceSink {
  readonly #db: DatabaseSync;
  readonly #onError: (err: unknown, op: string) => void;

  constructor(opts: SqliteDecisionTraceSinkOptions) {
    this.#onError = opts.onError ?? ((err, op) => console.error(`[decision-trace] ${op} 失败`, err));
    this.#db = new DatabaseSync(opts.path);
    try {
      this.#db.exec('PRAGMA journal_mode=WAL;');
      this.#migrate();
    } catch (err) {
      // 初始化失败必须关句柄,否则 Windows 会一直锁住 DB 文件。
      this.#db.close();
      throw err;
    }
  }

  #migrate(): void {
    this.#db.exec(`CREATE TABLE IF NOT EXISTS trace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const row = this.#db.prepare(`SELECT value FROM trace_meta WHERE key = 'schema_version'`).get();
    const current = row === undefined ? 0 : asNumber(row['value']);
    if (current > CURRENT_TRACE_SCHEMA_VERSION) {
      throw new Error(
        `决策 trace 库 schema_version=${current} 高于代码支持的 ${CURRENT_TRACE_SCHEMA_VERSION},拒绝打开`,
      );
    }
    if (current === CURRENT_TRACE_SCHEMA_VERSION) return;
    this.#db.exec('BEGIN');
    try {
      for (let v = current + 1; v <= CURRENT_TRACE_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step === undefined) throw new Error(`缺少 trace schema v${v} 的迁移步骤`);
        step(this.#db);
      }
      this.#db
        .prepare(
          `INSERT INTO trace_meta(key, value) VALUES('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(CURRENT_TRACE_SCHEMA_VERSION));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  record(trace: DecisionTrace): void {
    try {
      this.#db
        .prepare(
          `INSERT INTO decision_traces(
            correlation_id, trace_id, span_id, session_id, turn_id, created_at, latency_ms,
            user_text, recalled, emotion, pad, assertiveness, stance_notions, system, messages,
            provider, model, reply
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          trace.correlationId,
          trace.traceId ?? null,
          trace.spanId ?? null,
          trace.sessionId,
          trace.turnId,
          trace.createdAtMs,
          trace.latencyMs,
          trace.userText,
          JSON.stringify(trace.recalled),
          trace.emotion,
          trace.pad ? JSON.stringify(trace.pad) : null,
          trace.assertiveness,
          JSON.stringify(trace.stanceNotions),
          trace.system,
          JSON.stringify(trace.messages),
          trace.provider,
          trace.model,
          trace.reply,
        );
    } catch (err) {
      // 可观测性绝不打断回合(§3.2):记录失败仅告警。
      this.#onError(err, 'record');
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

export interface DecisionTraceSetup {
  readonly sink: DecisionTraceSink;
  readonly enabled: boolean;
  readonly dbPath?: string;
}

/**
 * 从环境变量装配决策 trace sink(行为即配置,§3.2):
 *   CHAT_A_DECISION_TRACE     = 1/on/true 启用 SQLite sink(默认关 → Noop)
 *   CHAT_A_DECISION_TRACE_DB  = 库路径(默认 chat-a-trace.db)
 * 启用后**无条件全量**(不采样);未启用零成本。
 */
export function createDecisionTraceSinkFromEnv(env: NodeJS.ProcessEnv = process.env): DecisionTraceSetup {
  const raw = (env['CHAT_A_DECISION_TRACE'] ?? '').toLowerCase();
  const enabled = raw === '1' || raw === 'on' || raw === 'true';
  if (!enabled) return { sink: new NoopDecisionTraceSink(), enabled: false };
  const dbPath = env['CHAT_A_DECISION_TRACE_DB'] ?? 'chat-a-trace.db';
  return { sink: new SqliteDecisionTraceSink({ path: dbPath }), enabled: true, dbPath };
}
