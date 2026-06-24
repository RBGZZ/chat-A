import type { PerceptionModality, RawPerceptionEvent } from '@chat-a/protocol';

export type { PerceptionModality, RawPerceptionEvent };

/**
 * 感知源(§12.1):世界输入的统一接入接口。每个源**自管采集**,经 `emit` 发出**结构化** raw 事件
 * (`raw:<modality>:<kind>`,不过早描述化)。源**只采集不决策**——是否成 signal、是否开口都在下游。
 *
 * 生命周期:`start(emit)` 拉起底层采集 → 持续 emit raw → `stop()` 停止;`health()` 供探活。
 */
export interface PerceptionSource {
  /** 源唯一标识(如 'system.tick'/'system.notification'/'mic')。 */
  readonly id: string;
  /** 模态(heard|sighted|felt|temporal|system)。 */
  readonly modality: PerceptionModality;
  /**
   * 启动采集。`emit` 由 Hub 注入——源每采到一次输入就 emit 一条 raw 事件。
   * 可返回 Promise(异步拉起);**不得抛**未捕获错误拖垮 Hub(§3.2,Hub 亦会兜底)。
   */
  start(emit: RawEmit): void | Promise<void>;
  /** 停止采集——之后不再 emit。幂等。 */
  stop(): void | Promise<void>;
  /** 健康状态——供 Hub/监督探活。 */
  health(): SourceHealth;
}

/** 源向 Hub 投递一条 raw 事件的回调。 */
export type RawEmit = (event: RawPerceptionEvent) => void;

/** 源健康状态。 */
export interface SourceHealth {
  /** 是否在正常运行(已 start 且未崩溃)。 */
  readonly healthy: boolean;
  /** 可选:最近一次 emit 的时间戳(ms),供"是否卡死"判断。 */
  readonly lastEmitMs?: number;
  /** 可选:崩溃/异常说明(可追溯)。 */
  readonly detail?: string;
}
