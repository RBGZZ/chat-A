import type { DatabaseSync } from 'node:sqlite';
import type { VoiceTraceEvent, VoiceTraceKind } from '@chat-a/protocol';
import { loadDatabaseSync } from './sqlite-loader';

/**
 * 语音管线可追溯事件落 SQLite(spec §5)。
 *
 * VoiceLoop 各决策/回合/采样边界 emit `VoiceTraceEvent`,装配层 fan-out 到本 sink。
 * 表 `voice_trace_events` 用「扁平 kind + JSON」存:常用过滤键(correlation_id/kind/at_ms)单列 +
 * 索引,kind 专属字段整体 `JSON.stringify` 进 `data_json`——捕获集字段差异大,加 kind 不改 schema。
 *
 * 照 `SqliteSpanSink` 同款手法:`loadDatabaseSync()`/node:sqlite、schema_version 元表 + 顺序迁移、
 * `PRAGMA journal_mode=WAL`、初始化失败关句柄、record/还原失败自吞降级(§3.2,可观测绝不打断回合)、
 * `':memory:'` 测试、`#closed` 守卫。可与决策 trace / span 同库共存(同库不同表),便于同 correlationId join。
 */

/** 当前 voice trace 库 schema 版本。破坏性/累加性变更 +1 并新增迁移。 */
export const CURRENT_VOICE_TRACE_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS voice_trace_events(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at_ms REAL NOT NULL,
        kind TEXT NOT NULL,
        correlation_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        data_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_vte_corr ON voice_trace_events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_vte_kind ON voice_trace_events(kind);
      CREATE INDEX IF NOT EXISTS idx_vte_at ON voice_trace_events(at_ms);
    `);
  },
};

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}

export interface SqliteVoiceTraceSinkOptions {
  /** 库文件路径;':memory:' 为内存库(测试用)。可与决策 trace / span 同库共存。 */
  readonly path: string;
  /** 错误回调(§3.2);默认 console.error。降级时记录而非抛出。 */
  readonly onError?: (err: unknown, op: string) => void;
}

/**
 * voice trace 落 SQLite(node:sqlite)。`record` 内部失败自吞降级——可观测性绝不打断回合(§3.2)。
 * schema 版本化 + 顺序迁移。提供只读还原(getByCorrelation/getByKind)供 CLI 与测试。
 */
export class SqliteVoiceTraceSink {
  readonly #db: DatabaseSync;
  readonly #onError: (err: unknown, op: string) => void;
  /** close 后置 true,后续 record/还原走降级,不触碰已关句柄。 */
  #closed = false;

  constructor(opts: SqliteVoiceTraceSinkOptions) {
    this.#onError = opts.onError ?? ((err, op) => console.error(`[voice-trace] ${op} 失败`, err));
    this.#db = new (loadDatabaseSync())(opts.path);
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
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS voice_trace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    );
    const row = this.#db
      .prepare(`SELECT value FROM voice_trace_meta WHERE key = 'schema_version'`)
      .get();
    const current = row === undefined ? 0 : asNumber(row['value']);
    if (current > CURRENT_VOICE_TRACE_SCHEMA_VERSION) {
      throw new Error(
        `voice trace 库 schema_version=${current} 高于代码支持的 ${CURRENT_VOICE_TRACE_SCHEMA_VERSION},拒绝打开`,
      );
    }
    if (current === CURRENT_VOICE_TRACE_SCHEMA_VERSION) return;
    this.#db.exec('BEGIN');
    try {
      for (let v = current + 1; v <= CURRENT_VOICE_TRACE_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step === undefined) throw new Error(`缺少 voice trace schema v${v} 的迁移步骤`);
        step(this.#db);
      }
      this.#db
        .prepare(
          `INSERT INTO voice_trace_meta(key, value) VALUES('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(CURRENT_VOICE_TRACE_SCHEMA_VERSION));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 当前库 schema 版本(测试/诊断用)。降级返回 -1。 */
  schemaVersion(): number {
    if (this.#closed) return -1;
    try {
      const row = this.#db
        .prepare(`SELECT value FROM voice_trace_meta WHERE key = 'schema_version'`)
        .get() as Record<string, unknown> | undefined;
      return row === undefined ? 0 : asNumber(row['value']);
    } catch (err) {
      this.#onError(err, 'schemaVersion');
      return -1;
    }
  }

  /**
   * 落一条语音 trace 事件:拆出 at_ms/kind/correlation_id/session_id/turn_id 单列,
   * 其余 kind 专属字段整体 `JSON.stringify` 进 data_json。失败自吞降级(§3.2)。
   */
  record(ev: VoiceTraceEvent): void {
    if (this.#closed) {
      this.#onError(new Error('sink 已关闭'), 'record');
      return;
    }
    try {
      // kind 专属字段 = 事件去掉公共/缝合键后的剩余字段(整体进 data_json)。
      const { atMs, kind, correlationId, sessionId, turnId, ...rest } = ev;
      this.#db
        .prepare(
          `INSERT INTO voice_trace_events(
            at_ms, kind, correlation_id, session_id, turn_id, data_json
          ) VALUES(?, ?, ?, ?, ?, ?)`,
        )
        .run(
          atMs,
          kind,
          correlationId ?? null,
          sessionId ?? null,
          turnId ?? null,
          JSON.stringify(rest),
        );
    } catch (err) {
      // 可观测性绝不打断回合(§3.2):记录失败仅告警。
      this.#onError(err, 'record');
    }
  }

  /** 取同 correlationId 全部事件,按 at_ms 升序(供 CLI 缝合)。降级返回 []。 */
  getByCorrelation(correlationId: string): VoiceTraceEvent[] {
    if (this.#closed) return [];
    try {
      const rows = this.#db
        .prepare(
          `SELECT * FROM voice_trace_events WHERE correlation_id = ? ORDER BY at_ms ASC, id ASC`,
        )
        .all(correlationId) as Record<string, unknown>[];
      return rows.map((r) => rowToEvent(r));
    } catch (err) {
      this.#onError(err, 'getByCorrelation');
      return [];
    }
  }

  /** 取指定 kind 全部事件,按 at_ms 升序。降级返回 []。 */
  getByKind(kind: VoiceTraceKind): VoiceTraceEvent[] {
    if (this.#closed) return [];
    try {
      const rows = this.#db
        .prepare(`SELECT * FROM voice_trace_events WHERE kind = ? ORDER BY at_ms ASC, id ASC`)
        .all(kind) as Record<string, unknown>[];
      return rows.map((r) => rowToEvent(r));
    } catch (err) {
      this.#onError(err, 'getByKind');
      return [];
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#db.close();
    } catch (err) {
      this.#onError(err, 'close');
    }
  }
}

/**
 * 把一行还原为 `VoiceTraceEvent`:单列(at_ms/kind/correlation_id/session_id/turn_id)+
 * `JSON.parse(data_json)`(kind 专属字段)合并;可空缝合键缺省时不展开(对齐 exactOptionalPropertyTypes)。
 */
function rowToEvent(row: Record<string, unknown>): VoiceTraceEvent {
  const rest = JSON.parse(String(row['data_json'])) as Record<string, unknown>;
  const base: Record<string, unknown> = {
    kind: String(row['kind']),
    atMs: asNumber(row['at_ms']),
    ...(row['correlation_id'] !== null && row['correlation_id'] !== undefined
      ? { correlationId: String(row['correlation_id']) }
      : {}),
    ...(row['session_id'] !== null && row['session_id'] !== undefined
      ? { sessionId: String(row['session_id']) }
      : {}),
    ...(row['turn_id'] !== null && row['turn_id'] !== undefined
      ? { turnId: String(row['turn_id']) }
      : {}),
    ...rest,
  };
  return base as unknown as VoiceTraceEvent;
}
