import type { Context } from '@opentelemetry/api';
import { SpanStatusCode, type HrTime } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { GENAI, CHAT_A } from './conventions';
import { SqliteSpanSink, type SpanRecord, type SpanStatusText } from './sqlite-span-trace';

/**
 * 自定义 SpanProcessor/Exporter:把结束的 OTel span(onEnd)投影并**异步**落 SQLite(§8.1)。
 *
 * 关键纪律(§3.2):
 * - 异步:onEnd 不同步阻塞写库——record 入队,microtask 批量排空,不在主流程热路径增延迟。
 * - 优雅降级:投影/写库失败只记日志,绝不抛回 OTel SDK 或主流程。
 * - 行为即配置:批量阈值外置,无 magic number。
 *
 * 采样取舍:本 processor 只落它**收到**的 span(= provider sampler 决定哪些 span 触发 onEnd)。
 * 决策真相源要「不采样、全量落」,故 `initTelemetry` 默认 sampler=AlwaysOn(见 telemetry.ts);
 * OTel 侧若要降噪,应放在导出/传输链路,而非 provider sampler——否则会饿死 SQLite。
 */

const DEFAULT_BATCH_SIZE = 32;

/** HrTime(`[秒, 纳秒]`)→ 毫秒(墙钟真实时刻 / 时长)。 */
export function hrTimeToMs(t: HrTime): number {
  const [seconds, nanos] = t;
  return seconds * 1e3 + nanos / 1e6;
}

/** OTel SpanStatusCode(0/1/2)→ 落库文本。 */
function statusToText(code: SpanStatusCode): SpanStatusText {
  if (code === SpanStatusCode.OK) return 'ok';
  if (code === SpanStatusCode.ERROR) return 'error';
  return 'unset';
}

function attrString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : v === undefined ? undefined : String(v);
}
function attrNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  return undefined;
}

/**
 * 把 `ReadableSpan` 投影成 `SpanRecord`(纯函数)。读 spanContext/parentSpanContext、
 * 真实 start/end/duration(HrTime→ms)、status、attributes 的 GenAI/私有键(取自 conventions)。
 */
export function toSpanRecord(span: ReadableSpan): SpanRecord {
  const sc = span.spanContext();
  const attrs = span.attributes;
  const status = span.status;
  const parentSpanId = span.parentSpanContext?.spanId;

  const operationName = attrString(attrs[GENAI.OPERATION_NAME]);
  const provider = attrString(attrs[GENAI.PROVIDER_NAME]);
  const model = attrString(attrs[GENAI.REQUEST_MODEL]);
  const inputTokens = attrNumber(attrs[GENAI.USAGE_INPUT_TOKENS]);
  const outputTokens = attrNumber(attrs[GENAI.USAGE_OUTPUT_TOKENS]);
  const outputType = attrString(attrs[GENAI.OUTPUT_TYPE]);
  const conversationId = attrString(attrs[GENAI.CONVERSATION_ID]);
  const sessionId = attrString(attrs[CHAT_A.SESSION_ID]);
  const turnId = attrString(attrs[CHAT_A.TURN_ID]);
  const correlationId = attrString(attrs[CHAT_A.CORRELATION_ID]);
  const statusMessage = status.message;

  return {
    traceId: sc.traceId,
    spanId: sc.spanId,
    ...(parentSpanId !== undefined ? { parentSpanId } : {}),
    name: span.name,
    startTimeMs: hrTimeToMs(span.startTime),
    endTimeMs: hrTimeToMs(span.endTime),
    durationMs: hrTimeToMs(span.duration),
    statusCode: statusToText(status.code),
    ...(statusMessage !== undefined ? { statusMessage } : {}),
    ...(operationName !== undefined ? { operationName } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(outputType !== undefined ? { outputType } : {}),
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  } satisfies SpanRecord;
}

/**
 * SpanExporter:把已投影的 span 批量交给 sink 落库。导出**绝不抛**回 SDK(§3.2)。
 * 既可单独用(塞进官方 BatchSpanProcessor),也被本包的 `SqliteSpanProcessor` 复用。
 */
export class SqliteSpanExporter implements SpanExporter {
  readonly #sink: SqliteSpanSink;
  readonly #onError: (err: unknown, op: string) => void;

  constructor(sink: SqliteSpanSink, onError?: (err: unknown, op: string) => void) {
    this.#sink = sink;
    this.#onError = onError ?? ((err, op) => console.error(`[span-exporter] ${op} 失败`, err));
  }

  export(spans: readonly ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    try {
      for (const span of spans) {
        // 投影 + 落库逐条吞错:单条坏 span 不连累整批。
        try {
          this.#sink.recordSpan(toSpanRecord(span));
        } catch (err) {
          this.#onError(err, 'export-one');
        }
      }
      resultCallback({ code: ExportResultCode.SUCCESS });
    } catch (err) {
      this.#onError(err, 'export');
      // 即便整体异常也回 SUCCESS:可观测性不得拖垮主流程,失败已记日志(§3.2)。
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  async shutdown(): Promise<void> {
    // 句柄关闭由 processor 统一管理(processor 持有 sink);此处不重复关。
  }

  async forceFlush(): Promise<void> {
    // 同步落库,无内部缓冲。
  }
}

export interface SqliteSpanProcessorOptions {
  /** 直接注入 sink(测试 / 复用同库);与 `path` 二选一。 */
  readonly sink?: SqliteSpanSink;
  /** 库路径(未注入 sink 时按此 new 一个);可与决策 trace 同库共存。 */
  readonly path?: string;
  /** 批量阈值:队列攒到此数即排空一次(外置,默认 32)。 */
  readonly batchSize?: number;
  /** 错误回调;默认 console.error。 */
  readonly onError?: (err: unknown, op: string) => void;
}

/**
 * SpanProcessor:onEnd 把 span 投影后入异步队列,microtask 批量落库(§3.2 不阻塞主流程)。
 * `forceFlush()` 同步排空(测试断言前用);`shutdown()` 排空 + 关 sink。全程吞错记日志。
 */
export class SqliteSpanProcessor implements SpanProcessor {
  readonly #sink: SqliteSpanSink;
  readonly #ownsSink: boolean;
  readonly #onError: (err: unknown, op: string) => void;
  readonly #batchSize: number;
  /** 待落库队列(投影后的 record)。 */
  #queue: SpanRecord[] = [];
  /** 是否已排过一次 microtask(避免重复排)。 */
  #flushScheduled = false;
  #shutdown = false;

  constructor(opts: SqliteSpanProcessorOptions) {
    this.#onError = opts.onError ?? ((err, op) => console.error(`[span-processor] ${op} 失败`, err));
    this.#batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
    if (opts.sink !== undefined) {
      this.#sink = opts.sink;
      this.#ownsSink = false;
    } else if (opts.path !== undefined) {
      this.#sink = new SqliteSpanSink({ path: opts.path, onError: this.#onError });
      this.#ownsSink = true;
    } else {
      throw new Error('SqliteSpanProcessor 需提供 sink 或 path');
    }
  }

  onStart(_span: unknown, _parentContext: Context): void {
    /* 不在 start 落库:只在 onEnd 投影结束态。 */
  }

  onEnd(span: ReadableSpan): void {
    if (this.#shutdown) return;
    try {
      this.#queue.push(toSpanRecord(span));
    } catch (err) {
      // 投影失败不连累主流程(§3.2)。
      this.#onError(err, 'onEnd-project');
      return;
    }
    // 攒够一批 → 立即排空;否则下个 microtask 排空(异步,不阻塞 onEnd 调用方)。
    if (this.#queue.length >= this.#batchSize) {
      this.#drain();
    } else if (!this.#flushScheduled) {
      this.#flushScheduled = true;
      queueMicrotask(() => {
        this.#flushScheduled = false;
        this.#drain();
      });
    }
  }

  /** 同步排空队列:逐条落库,吞错记日志(§3.2)。 */
  #drain(): void {
    if (this.#queue.length === 0) return;
    const batch = this.#queue;
    this.#queue = [];
    for (const record of batch) {
      try {
        this.#sink.recordSpan(record);
      } catch (err) {
        this.#onError(err, 'drain-one');
      }
    }
  }

  async forceFlush(): Promise<void> {
    try {
      this.#drain();
    } catch (err) {
      this.#onError(err, 'forceFlush');
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutdown) return;
    try {
      this.#drain();
    } catch (err) {
      this.#onError(err, 'shutdown-drain');
    } finally {
      this.#shutdown = true;
      // 只关自己 new 的 sink;注入的 sink 由调用方负责。
      if (this.#ownsSink) this.#sink.close();
    }
  }
}

export type SpanProcessorSetup =
  | { readonly enabled: false }
  | { readonly enabled: true; readonly processor: SqliteSpanProcessor; readonly dbPath: string };

/**
 * 从环境变量装配 span→SQLite processor(行为即配置,§3.2):
 *   CHAT_A_OTEL_SPAN_SQLITE       = 1/on/true 启用(默认关 → 零成本,不开句柄)
 *   CHAT_A_OTEL_SPAN_SQLITE_DB    = 库路径(默认 chat-a-trace.db,与决策 trace 同库共存)
 *   CHAT_A_OTEL_SPAN_SQLITE_BATCH = 批量阈值(默认 32)
 * 启用后产出可塞进 `initTelemetry({ spanProcessors })` 的 processor。
 * 注:真相源「全量落」需保持 provider sampler 为全采(initTelemetry 默认 AlwaysOn)。
 */
export function createSpanProcessorFromEnv(env: NodeJS.ProcessEnv = process.env): SpanProcessorSetup {
  const raw = (env['CHAT_A_OTEL_SPAN_SQLITE'] ?? '').toLowerCase();
  const enabled = raw === '1' || raw === 'on' || raw === 'true';
  if (!enabled) return { enabled: false };
  const dbPath = env['CHAT_A_OTEL_SPAN_SQLITE_DB'] ?? 'chat-a-trace.db';
  const batchRaw = env['CHAT_A_OTEL_SPAN_SQLITE_BATCH'];
  const batchSize = batchRaw !== undefined && Number.isFinite(Number(batchRaw)) && Number(batchRaw) > 0
    ? Number(batchRaw)
    : undefined;
  const processor = new SqliteSpanProcessor({
    path: dbPath,
    ...(batchSize !== undefined ? { batchSize } : {}),
  });
  return { enabled: true, processor, dbPath };
}
