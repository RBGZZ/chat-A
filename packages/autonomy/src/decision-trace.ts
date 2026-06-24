/**
 * autonomy 决策 trace 写入接缝(承 §8.1 autonomy 决策可追溯)。
 *
 * 每次主动决策(silent/speak/idle)+ 输入摘要 + reason **MUST 落可重放 trace**(§8.1)。
 * 本包 standalone(§3.1 依赖倒置):**不直接 import observability/SQLite**,只定义单向写入接缝;
 * 真实落库由接线层提供 sink 实现(把 `AutonomyDecisionTrace` 写进 SQLite 决策 trace 表),
 * 与回合层 `DecisionTrace` 互补(同 correlationId 缝合)。
 *
 * 纪律:`record` MUST 不抛以致中断决策回路(实现内部自吞降级,§3.2);不在用户首字热路径。
 */

/** autonomy 一次主动决策的三态裁决(给模型显式「沉默」选项 → silent 多数)。 */
export type AutonomyDecisionKind = 'silent' | 'speak' | 'idle';

/** 一条 autonomy 决策 trace(足以重建「她这一 tick 为何沉默/开口」)。 */
export interface AutonomyDecisionTrace {
  /** 与回合 trace / 总线事件缝合(§8.1);无上下文时由接线层补。 */
  readonly correlationId?: string;
  /** 发起决策的技能 id(追溯:谁想说)。 */
  readonly skillId: string;
  /** 决策时刻(注入时钟取,确定可重放)。 */
  readonly atMs: number;
  /** 三态裁决。 */
  readonly decision: AutonomyDecisionKind;
  /** 人类可读理由(为何 silent/speak/idle)。 */
  readonly reason: string;
  /** 决策输入摘要(技能候选 + gather context;供重建)。 */
  readonly input: AutonomyDecisionInput;
  /** speak 时实际拟说文案(silent/idle 省略)。 */
  readonly text?: string;
  /** 决策 LLM 是否失败/超时退回(true=非模型判定,而是降级 silent)。 */
  readonly fellBack?: boolean;
}

/** 决策输入摘要(决策 LLM 的喂入,落 trace 供重放)。 */
export interface AutonomyDecisionInput {
  /** 技能给出的候选发言文本(0..n)。 */
  readonly candidates: readonly string[];
  /** gather 的上下文摘要(情绪 / 未了话题 / 时间等;自由文本,接线层组装)。 */
  readonly context?: string;
}

/** autonomy 决策 trace 写入接缝(单向:决策回路 → sink)。 */
export interface AutonomyDecisionSink {
  record(trace: AutonomyDecisionTrace): void;
}

/** 默认空实现:不写,零成本(未配置决策 trace 时用)。 */
export class NoopAutonomyDecisionSink implements AutonomyDecisionSink {
  record(): void {
    /* 不写 */
  }
}

/** 内存收集 sink(测试/调试用:落入数组供断言)。 */
export class InMemoryAutonomyDecisionSink implements AutonomyDecisionSink {
  readonly #traces: AutonomyDecisionTrace[] = [];
  record(trace: AutonomyDecisionTrace): void {
    this.#traces.push(trace);
  }
  get traces(): readonly AutonomyDecisionTrace[] {
    return this.#traces;
  }
}
