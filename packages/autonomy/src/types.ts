/**
 * autonomy 引擎公共类型与接缝(承 canonical §7 / neuro-ecosystem-findings §5)。
 *
 * 全确定性内核所需的最小类型集合:注入式时钟、三级事件优先级、自主事件、
 * requestSpeak 仲裁的请求/状态/结果。**不依赖 runtime/cognition/persona/memory**
 * (本切片 standalone,§3.1 依赖倒置:内核只认接口/类型,不认具体实现)。
 */

/**
 * 时钟接缝(承 §3.2 可测试性):内核取"现在"一律经此,**绝不直接调 `Date.now()`**。
 * 测试注入 fake 时钟即可让"再想一次"扣预算、技能调度等行为完全确定。
 */
export interface Clock {
  /** 当前时刻(毫秒)。 */
  now(): number;
}

/** 系统默认壁钟实现(生产用;测试用 fake 替换)。 */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * 事件优先级(承 §7 / §4.2 单消费者优先级队列):
 * - `URGENT`:用户语音等"先听你、先处理你"的最高级(§7 软反转,默认 URGENT)。
 * - `PERCEPTION`:计时器 / 记忆唤起 / 情绪漂移等感知信号。
 * - `LOWEST`:no-action 合成的"再想一次"自言自语——永远让位于用户/感知。
 *
 * ⚠️ 本切片 standalone,不接 LightVoiceBus;接线切片再把总线事件映射到这三级。
 */
export type EventPriority = 'URGENT' | 'PERCEPTION' | 'LOWEST';

/**
 * 优先级数值序(单一权威,行为即配置):数值越大越优先。
 * 出队取最大值;集中于此,杜绝散落 magic number。
 */
export const PRIORITY_RANK: Readonly<Record<EventPriority, number>> = {
  URGENT: 3,
  PERCEPTION: 2,
  LOWEST: 1,
};

/**
 * 自主事件(承 §7):队列里流动的最小单位。
 * - `kind`:事件种类标签(如 `'user:speech'`/`'timer:tick'`/`'self:reconsider'`),
 *   本切片不约束取值集合(接线切片再对齐总线事件名);仅 `synthetic` 有内核语义。
 * - `synthetic`:是否为 no-action 预算合成的"再想一次"事件(`LOWEST`)。
 *   预算重置时按 `synthetic && priority==='LOWEST'` 批量丢弃排队的自言自语。
 * - `payload`:可选随附数据(本切片内核不解读)。
 * - `atMs`:入队时刻(由注入时钟取,便于追溯)。
 */
export interface AutonomyEvent {
  readonly kind: string;
  readonly priority: EventPriority;
  readonly synthetic: boolean;
  readonly atMs: number;
  readonly payload?: unknown;
}

/** no-action 预算合成的"再想一次"事件 kind(单一权威常量,避免散落字面量)。 */
export const RECONSIDER_EVENT_KIND = 'self:reconsider';

/**
 * 发言请求(承 §7 requestSpeak 仲裁):某技能"想说"时提交的意图。
 * - `skillId`:发起技能,便于追溯。
 * - `priority`:本次发言的优先级(用于与"在说者"比较以决定抢占)。
 * - `deferrable`:忙时是否可延续(记 history 待续 / resumeBuffer),而非直接丢弃。
 * - `text`:想说的内容(本切片仲裁器不解读,仅透传供调用方使用)。
 */
export interface SpeakRequest {
  readonly skillId: string;
  readonly priority: EventPriority;
  readonly deferrable: boolean;
  readonly text?: string;
}

/**
 * 输出仲裁的"忙闲"状态(承 §7 单一 is_speaking 硬闸):
 * 由调用方维护并传入,仲裁器是纯函数、内部不存播放状态(利确定性测试)。
 */
export interface SpeakState {
  /** 单一硬闸:当前是否正在说话。 */
  readonly isSpeaking: boolean;
  /** 当前在说者的优先级(`isSpeaking=false` 时无意义,可省)。 */
  readonly speakingPriority?: EventPriority;
}

/** 仲裁裁决:真说 / 记 history 待续 / 丢弃。 */
export type SpeakDecision = 'speak' | 'defer' | 'drop';

/**
 * 仲裁结果(承 §7):
 * - `decision`:三态裁决。
 * - `preempted`:`decision==='speak'` 且发生了抢占(打断在说者)时为 true;
 *   调用方据此触发 abort 三件套(本切片只给信号,不真 abort——那在 runtime 层)。
 * - `reason`:人类可读理由,便于追溯(§8.1 autonomy 决策可追溯)。
 */
export interface SpeakOutcome {
  readonly decision: SpeakDecision;
  readonly preempted: boolean;
  readonly reason: string;
}
