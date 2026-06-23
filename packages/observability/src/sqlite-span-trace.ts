import { DatabaseSync } from 'node:sqlite';

/**
 * OTel span 落 SQLite(§8.1 两层追踪「OTel→SQLite 落地」一半)。
 *
 * 与决策 trace 互补:决策 trace = 回合级、由编排层在收尾组装的完整决策链(单一真相源);
 * span = 来自 OTel span 树(session→turn→{stt,llm,tts,classify,autonomy})的**阶段耗时与
 * GenAI 属性快照**,用与决策记录**同一套 trace_id/span_id** 落库,故二者在同一 SQLite 库里
 * 凭 trace_id/span_id 缝合——「OTel 发现慢回合 → 跳到 SQLite 看该回合各阶段耗时 + 完整决策」。
 *
 * 关键纪律:落库失败自吞降级,绝不打断主流程(§3.2);schema 版本化 + 顺序迁移(§3.2)。
 * 与 `sqlite-decision-trace.ts` 共用同一套手法,但持有**独立的 `span_meta` 版本号与 `otel_spans` 表**,
 * 可与决策 trace 同库共存(同库不同表),也可独立库。
 */

/** 当前 span 库 schema 版本。破坏性/累加性变更 +1 并新增迁移。 */
export const CURRENT_SPAN_SCHEMA_VERSION = 1;

/** span 状态码文本(对应 OTel `SpanStatusCode`:0/1/2 → unset/ok/error)。 */
export type SpanStatusText = 'unset' | 'ok' | 'error';

/**
 * 一条落库的 span 快照(投影自 OTel `ReadableSpan`)。全部 readonly。
 * 时刻字段为**真实墙钟毫秒**(锚定语音真实时刻),时长为毫秒。
 * GenAI / 私有关联属性为**可选**:span 上无该属性时省略(落库写 NULL)。
 */
export interface SpanRecord {
  readonly traceId: string;
  readonly spanId: string;
  /** 父 span_id;根 span 无父时省略。 */
  readonly parentSpanId?: string;
  readonly name: string;
  /** 开始墙钟时刻(ms)。 */
  readonly startTimeMs: number;
  /** 结束墙钟时刻(ms)。 */
  readonly endTimeMs: number;
  /** 时长(ms)。 */
  readonly durationMs: number;
  readonly statusCode: SpanStatusText;
  readonly statusMessage?: string;
  // —— GenAI 语义约定属性(LLM span 可得时填,键见 conventions.ts GENAI)——
  readonly operationName?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly outputType?: string;
  readonly conversationId?: string;
  // —— chat-A 私有关联(可缝合决策记录;键见 conventions.ts CHAT_A)——
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly correlationId?: string;
}

const MIGRATIONS: Record<number, (db: DatabaseSync) => void> = {
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS otel_spans(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        name TEXT NOT NULL,
        start_time_ms REAL NOT NULL,
        end_time_ms REAL NOT NULL,
        duration_ms REAL NOT NULL,
        status_code TEXT NOT NULL,
        status_message TEXT,
        operation_name TEXT,
        provider TEXT,
        model TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        output_type TEXT,
        conversation_id TEXT,
        session_id TEXT,
        turn_id TEXT,
        correlation_id TEXT
      );
      -- 同一 trace 下 span 唯一:支持幂等 upsert + 缝合按 (trace_id,span_id) 精确取。
      CREATE UNIQUE INDEX IF NOT EXISTS idx_spans_trace_span ON otel_spans(trace_id, span_id);
      CREATE INDEX IF NOT EXISTS idx_spans_trace ON otel_spans(trace_id);
      CREATE INDEX IF NOT EXISTS idx_spans_correlation ON otel_spans(correlation_id);
    `);
  },
};

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}

export interface SqliteSpanSinkOptions {
  /** 库文件路径;':memory:' 为内存库(测试用)。可与决策 trace 同库共存。 */
  readonly path: string;
  /** 错误回调(§8.1 error 层);默认 console.error。降级时记录而非抛出。 */
  readonly onError?: (err: unknown, op: string) => void;
}

/**
 * span 落 SQLite(node:sqlite)。`recordSpan` 内部失败自吞降级——可观测性绝不打断回合(§3.2)。
 * schema 版本化 + 顺序迁移(§3.2)。提供只读还原供测试与 CLI 缝合查询。
 */
export class SqliteSpanSink {
  readonly #db: DatabaseSync;
  readonly #onError: (err: unknown, op: string) => void;
  /** close 后置 true,后续 record/还原走降级,不触碰已关句柄。 */
  #closed = false;

  constructor(opts: SqliteSpanSinkOptions) {
    this.#onError = opts.onError ?? ((err, op) => console.error(`[span-trace] ${op} 失败`, err));
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
    this.#db.exec(`CREATE TABLE IF NOT EXISTS span_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const row = this.#db.prepare(`SELECT value FROM span_meta WHERE key = 'schema_version'`).get();
    const current = row === undefined ? 0 : asNumber(row['value']);
    if (current > CURRENT_SPAN_SCHEMA_VERSION) {
      throw new Error(
        `span 库 schema_version=${current} 高于代码支持的 ${CURRENT_SPAN_SCHEMA_VERSION},拒绝打开`,
      );
    }
    if (current === CURRENT_SPAN_SCHEMA_VERSION) return;
    this.#db.exec('BEGIN');
    try {
      for (let v = current + 1; v <= CURRENT_SPAN_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (step === undefined) throw new Error(`缺少 span schema v${v} 的迁移步骤`);
        step(this.#db);
      }
      this.#db
        .prepare(
          `INSERT INTO span_meta(key, value) VALUES('schema_version', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(String(CURRENT_SPAN_SCHEMA_VERSION));
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * 落一条 span(同 (trace_id,span_id) 幂等 upsert,后写覆盖)。
   * 失败自吞降级(§3.2);可选属性缺省落 NULL。
   */
  recordSpan(span: SpanRecord): void {
    if (this.#closed) {
      this.#onError(new Error('sink 已关闭'), 'recordSpan');
      return;
    }
    try {
      this.#db
        .prepare(
          `INSERT INTO otel_spans(
            trace_id, span_id, parent_span_id, name, start_time_ms, end_time_ms, duration_ms,
            status_code, status_message, operation_name, provider, model,
            input_tokens, output_tokens, output_type, conversation_id,
            session_id, turn_id, correlation_id
          ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(trace_id, span_id) DO UPDATE SET
            parent_span_id = excluded.parent_span_id,
            name = excluded.name,
            start_time_ms = excluded.start_time_ms,
            end_time_ms = excluded.end_time_ms,
            duration_ms = excluded.duration_ms,
            status_code = excluded.status_code,
            status_message = excluded.status_message,
            operation_name = excluded.operation_name,
            provider = excluded.provider,
            model = excluded.model,
            input_tokens = excluded.input_tokens,
            output_tokens = excluded.output_tokens,
            output_type = excluded.output_type,
            conversation_id = excluded.conversation_id,
            session_id = excluded.session_id,
            turn_id = excluded.turn_id,
            correlation_id = excluded.correlation_id`,
        )
        .run(
          span.traceId,
          span.spanId,
          span.parentSpanId ?? null,
          span.name,
          span.startTimeMs,
          span.endTimeMs,
          span.durationMs,
          span.statusCode,
          span.statusMessage ?? null,
          span.operationName ?? null,
          span.provider ?? null,
          span.model ?? null,
          span.inputTokens ?? null,
          span.outputTokens ?? null,
          span.outputType ?? null,
          span.conversationId ?? null,
          span.sessionId ?? null,
          span.turnId ?? null,
          span.correlationId ?? null,
        );
    } catch (err) {
      // 可观测性绝不打断回合(§3.2):记录失败仅告警。
      this.#onError(err, 'recordSpan');
    }
  }

  /** 取同 trace 下全部 span,按 start 升序(供 CLI 缝合阶段耗时)。降级返回 []。 */
  getSpansByTraceId(traceId: string): SpanRecord[] {
    if (this.#closed) return [];
    try {
      const rows = this.#db
        .prepare(`SELECT * FROM otel_spans WHERE trace_id = ? ORDER BY start_time_ms ASC, id ASC`)
        .all(traceId) as Record<string, unknown>[];
      return rows.map((r) => rowToSpan(r));
    } catch (err) {
      this.#onError(err, 'getSpansByTraceId');
      return [];
    }
  }

  /** 按 trace_id + span_id 精确取一条 span(§8.1 精确缝合点)。未命中/降级返回 undefined。 */
  getSpanById(traceId: string, spanId: string): SpanRecord | undefined {
    if (this.#closed) return undefined;
    try {
      const row = this.#db
        .prepare(`SELECT * FROM otel_spans WHERE trace_id = ? AND span_id = ? LIMIT 1`)
        .get(traceId, spanId) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return rowToSpan(row);
    } catch (err) {
      this.#onError(err, 'getSpanById');
      return undefined;
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

/** 把一行还原为 `SpanRecord`;可空列按 exactOptionalPropertyTypes 条件展开。 */
function rowToSpan(row: Record<string, unknown>): SpanRecord {
  const opt = <T>(key: string, map: (v: unknown) => T): Record<string, T> => {
    const v = row[key];
    return v !== null && v !== undefined ? ({ [key]: map(v) } as Record<string, T>) : {};
  };
  const str = (v: unknown): string => String(v);
  return {
    traceId: String(row['trace_id']),
    spanId: String(row['span_id']),
    ...(row['parent_span_id'] !== null && row['parent_span_id'] !== undefined
      ? { parentSpanId: String(row['parent_span_id']) }
      : {}),
    name: String(row['name']),
    startTimeMs: asNumber(row['start_time_ms']),
    endTimeMs: asNumber(row['end_time_ms']),
    durationMs: asNumber(row['duration_ms']),
    statusCode: String(row['status_code']) as SpanStatusText,
    ...(row['status_message'] !== null && row['status_message'] !== undefined
      ? { statusMessage: String(row['status_message']) }
      : {}),
    ...(row['operation_name'] !== null && row['operation_name'] !== undefined
      ? { operationName: str(row['operation_name']) }
      : {}),
    ...opt('provider', str),
    ...opt('model', str),
    ...(row['input_tokens'] !== null && row['input_tokens'] !== undefined
      ? { inputTokens: asNumber(row['input_tokens']) }
      : {}),
    ...(row['output_tokens'] !== null && row['output_tokens'] !== undefined
      ? { outputTokens: asNumber(row['output_tokens']) }
      : {}),
    ...(row['output_type'] !== null && row['output_type'] !== undefined
      ? { outputType: str(row['output_type']) }
      : {}),
    ...(row['conversation_id'] !== null && row['conversation_id'] !== undefined
      ? { conversationId: str(row['conversation_id']) }
      : {}),
    ...(row['session_id'] !== null && row['session_id'] !== undefined
      ? { sessionId: str(row['session_id']) }
      : {}),
    ...(row['turn_id'] !== null && row['turn_id'] !== undefined ? { turnId: str(row['turn_id']) } : {}),
    ...(row['correlation_id'] !== null && row['correlation_id'] !== undefined
      ? { correlationId: str(row['correlation_id']) }
      : {}),
  } satisfies SpanRecord;
}
