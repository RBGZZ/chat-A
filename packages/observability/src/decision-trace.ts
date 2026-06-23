/**
 * 每回合决策 trace(§8.1 可重放真相源)。与 OTel 两层追踪互补:
 * OTel = 实时/可采样/运维;决策 trace = 持久/不采样/单一真相源,存完整 prompt+召回+情绪,
 * 二者用同 trace_id/span_id + correlation_id 缝合(见 conventions.ts)。
 *
 * 关键纪律:由回合编排层(Conversation)在回合**收尾**(取得回复、落记忆后)组装并写入,
 * 不走 OTel SpanProcessor(span 属性有损 + 会采样,违背"无条件全量")。
 */

/** 一条召回记忆的快照(P1"打分"即 hits 关键词级)。 */
export interface DecisionTraceRecalled {
  readonly text: string;
  readonly kind?: string;
  readonly subject: string;
  readonly hits: number;
}

/** 一回合完整决策链(足以重建"她为什么这么说")。 */
export interface DecisionTrace {
  readonly correlationId: string;
  /** OTel 缝合键;无 OTel 时 undefined。 */
  readonly traceId?: string;
  readonly spanId?: string;
  readonly sessionId: string;
  readonly turnId: string;
  readonly createdAtMs: number;
  /** 回合总延迟(ms)。 */
  readonly latencyMs: number;
  readonly userText: string;
  readonly recalled: readonly DecisionTraceRecalled[];
  readonly emotion: string;
  readonly pad?: { readonly pleasure: number; readonly arousal: number; readonly dominance: number };
  readonly assertiveness: number;
  /** 本轮命中、她有立场的观点(§7#3)。 */
  readonly stanceNotions: readonly string[];
  /** 当轮负面人际姿态(§7#6:'sulking'/'withdrawn');无姿态时省略。 */
  readonly posture?: string;
  // —— 语义召回元数据(§5.5/§8.1):回合层启用语义召回时由编排层透传;
  //    纯加法,关闭语义/缺省时全部省略(向后兼容,落库写 NULL)。
  /** 本轮是否实际用上了语义向量召回(true=用了 queryVector;false=超时/失败退关键词快路径)。 */
  readonly semanticUsed?: boolean;
  /** query 嵌入耗时(ms;含缓存命中=0)。 */
  readonly embedLatencyMs?: number;
  /** query 嵌入是否超过有界预算被中断。 */
  readonly embedTimedOut?: boolean;
  /** query 嵌入是否命中 LRU 缓存。 */
  readonly embedCacheHit?: boolean;
  /** 最终组装的 system 与 messages(完整,仅落本地,绝不导出远端)。 */
  readonly system: string;
  readonly messages: readonly { readonly role: string; readonly content: string }[];
  readonly provider: string;
  readonly model: string;
  readonly reply: string;
}

/**
 * 决策 trace 写入接缝(§3.1,单向:编排层 → sink)。`record` 由编排层在回合收尾调用,
 * MUST 不抛以致中断回合(实现内部自吞降级,§3.2),且发生在流式首字之后(不增首字延迟)。
 */
export interface DecisionTraceSink {
  record(trace: DecisionTrace): void;
  /** 释放底层资源(SQLite 句柄等);Noop 实现可空操作。 */
  close(): void;
}

/** 默认空实现:不写,零成本(未配置决策 trace 时用)。 */
export class NoopDecisionTraceSink implements DecisionTraceSink {
  record(): void {
    /* 不写 */
  }
  close(): void {
    /* 无资源 */
  }
}
