import { DatabaseSync } from 'node:sqlite';
import type { DecisionTrace, DecisionTraceRecalled } from './decision-trace';

/**
 * 决策 trace **只读**查询(§8.1 可重放落地的"查回/回放"一半)。
 *
 * 关键纪律:reader 纯只读——只 SELECT,绝不建表/迁移/写,亦不依赖也不触碰
 * `SqliteDecisionTraceSink` 的写契约(单向:库 → reader)。sink 仍是唯一写者。
 * 库不存在 / 表缺失 / 损坏 → 优雅降级(空结果 + 告警,不崩,§3.2)。
 */

/** 一回合的轻量摘要(用于"列最近 N 回合",不含完整 prompt)。 */
export interface DecisionTraceSummary {
  readonly turnId: string;
  readonly sessionId: string;
  readonly correlationId: string;
  readonly traceId?: string;
  readonly createdAtMs: number;
  /** 用户输入摘要(截断)。 */
  readonly userTextSummary: string;
  /** reply 摘要(截断)。 */
  readonly replySummary: string;
}

export interface ListRecentOptions {
  /** 仅列该会话的回合;省略则跨会话。 */
  readonly sessionId?: string;
  /** 最多返回多少条(默认 20)。 */
  readonly limit?: number;
  /** 摘要截断字符数(默认 40)。 */
  readonly summaryChars?: number;
}

export interface DecisionTraceReaderOptions {
  /** 库文件路径;':memory:' 仅供测试(只读内存库需同进程预填)。 */
  readonly path: string;
  /** 告警回调(降级层);默认 console.warn。降级时记录而非抛出。 */
  readonly onWarn?: (err: unknown, op: string) => void;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_SUMMARY_CHARS = 40;

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}

/** 截断为可读摘要(按字符数,超出加省略号);非字符串安全降级为空串。 */
function summarize(v: unknown, chars: number): string {
  const s = typeof v === 'string' ? v : '';
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > chars ? `${oneLine.slice(0, chars)}…` : oneLine;
}

/** 安全 JSON 解析:失败回退默认值(库被外部改坏也不崩)。 */
function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

export class DecisionTraceReader {
  readonly #onWarn: (err: unknown, op: string) => void;
  readonly #path: string;
  /** 只读句柄;打开失败时为 null(后续查询走降级)。 */
  #db: DatabaseSync | null = null;

  constructor(opts: DecisionTraceReaderOptions) {
    this.#onWarn = opts.onWarn ?? ((err, op) => console.warn(`[decision-trace-reader] ${op} 告警`, err));
    this.#path = opts.path;
    try {
      // 只读打开:不创建库、不写。库不存在/损坏在此抛 → 降级。
      // 注意:node:sqlite 选项名为 `readOnly`(大写 O);小写 `readonly` 不报错但**不强制只读**。
      this.#db = new DatabaseSync(this.#path, { readOnly: true });
    } catch (err) {
      this.#onWarn(err, 'open');
      this.#db = null;
    }
  }

  /** 列出最近 N 回合(可按 sessionId 过滤),按时间倒序。降级返回 []。 */
  listRecent(opts: ListRecentOptions = {}): DecisionTraceSummary[] {
    const db = this.#db;
    if (db === null) return [];
    const limit = opts.limit ?? DEFAULT_LIMIT;
    const chars = opts.summaryChars ?? DEFAULT_SUMMARY_CHARS;
    try {
      const where = opts.sessionId !== undefined ? 'WHERE session_id = ?' : '';
      const sql = `SELECT turn_id, session_id, correlation_id, trace_id, created_at, user_text, reply
                   FROM decision_traces ${where}
                   ORDER BY created_at DESC, id DESC
                   LIMIT ?`;
      const stmt = db.prepare(sql);
      const rows = (
        opts.sessionId !== undefined ? stmt.all(opts.sessionId, limit) : stmt.all(limit)
      ) as Record<string, unknown>[];
      return rows.map((row) => {
        const traceId = row['trace_id'];
        return {
          turnId: String(row['turn_id']),
          sessionId: String(row['session_id']),
          correlationId: String(row['correlation_id']),
          ...(traceId !== null && traceId !== undefined ? { traceId: String(traceId) } : {}),
          createdAtMs: asNumber(row['created_at']),
          userTextSummary: summarize(row['user_text'], chars),
          replySummary: summarize(row['reply'], chars),
        } satisfies DecisionTraceSummary;
      });
    } catch (err) {
      // 表缺失/损坏 → 降级为空结果。
      this.#onWarn(err, 'listRecent');
      return [];
    }
  }

  /** 按 turnId 取单回合完整决策链;未命中/降级返回 undefined。 */
  getByTurnId(turnId: string): DecisionTrace | undefined {
    return this.#getBy('turn_id', turnId, 'getByTurnId');
  }

  /** 按 correlationId 取单回合完整决策链;未命中/降级返回 undefined。 */
  getByCorrelationId(correlationId: string): DecisionTrace | undefined {
    return this.#getBy('correlation_id', correlationId, 'getByCorrelationId');
  }

  /** 按 OTel trace_id 取单回合完整决策链;未命中/降级返回 undefined。 */
  getByTraceId(traceId: string): DecisionTrace | undefined {
    return this.#getBy('trace_id', traceId, 'getByTraceId');
  }

  /**
   * 按 OTel `trace_id` + `span_id` **精确**取单回合完整决策链(§8.1 两层同 ID 缝合的精确缝合点)。
   * 一条 OTel trace 下可能挂多个 span/回合,trace_id 单键可能多命中;span_id 配合可定位到产出
   * 该决策的具体 span。未命中 / 降级返回 undefined。
   */
  getByTraceAndSpanId(traceId: string, spanId: string): DecisionTrace | undefined {
    const db = this.#db;
    if (db === null) return undefined;
    try {
      const row = db
        .prepare(
          `SELECT * FROM decision_traces WHERE trace_id = ? AND span_id = ?
           ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(traceId, spanId) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return this.#rowToTrace(row);
    } catch (err) {
      this.#onWarn(err, 'getByTraceAndSpanId');
      return undefined;
    }
  }

  #getBy(column: string, value: string, op: string): DecisionTrace | undefined {
    const db = this.#db;
    if (db === null) return undefined;
    try {
      // 同一标识可能有多条(理论上 turnId 唯一,但容错取最近一条)。
      const row = db
        .prepare(`SELECT * FROM decision_traces WHERE ${column} = ? ORDER BY created_at DESC, id DESC LIMIT 1`)
        .get(value) as Record<string, unknown> | undefined;
      if (row === undefined) return undefined;
      return this.#rowToTrace(row);
    } catch (err) {
      this.#onWarn(err, op);
      return undefined;
    }
  }

  /** 把一行还原为 `DecisionTrace`;可空列按 exactOptionalPropertyTypes 条件展开。 */
  #rowToTrace(row: Record<string, unknown>): DecisionTrace {
    const traceId = row['trace_id'];
    const spanId = row['span_id'];
    const pad = parseJson<DecisionTrace['pad'] | null>(row['pad'], null);
    const posture = row['posture'];
    return {
      correlationId: String(row['correlation_id']),
      ...(traceId !== null && traceId !== undefined ? { traceId: String(traceId) } : {}),
      ...(spanId !== null && spanId !== undefined ? { spanId: String(spanId) } : {}),
      sessionId: String(row['session_id']),
      turnId: String(row['turn_id']),
      createdAtMs: asNumber(row['created_at']),
      latencyMs: asNumber(row['latency_ms']),
      userText: String(row['user_text']),
      recalled: parseJson<DecisionTraceRecalled[]>(row['recalled'], []),
      emotion: String(row['emotion']),
      ...(pad ? { pad } : {}),
      assertiveness: asNumber(row['assertiveness']),
      stanceNotions: parseJson<string[]>(row['stance_notions'], []),
      ...(posture !== null && posture !== undefined ? { posture: String(posture) } : {}),
      system: String(row['system']),
      messages: parseJson<DecisionTrace['messages'][number][]>(row['messages'], []),
      provider: String(row['provider']),
      model: String(row['model']),
      reply: String(row['reply']),
    } satisfies DecisionTrace;
  }

  /** 释放只读句柄。 */
  close(): void {
    if (this.#db === null) return;
    try {
      this.#db.close();
    } catch (err) {
      this.#onWarn(err, 'close');
    } finally {
      this.#db = null;
    }
  }
}
