/**
 * A 层总线事件契约(承 §4.2):**跨模块、粗粒度、低频**。
 * gateway / cognition / providers / 外界交互 之间只走这些事件。
 *
 * 高频流式数据(音频帧、STT partial、LLM token、TTS 音频块)属 **B 层"帧"**
 * (在 `runtime` 帧管线内,不在此),**不上总线**——避免高频 + deepFreeze 成本 +
 * 破坏分层("cognition/providers 只见总线事件,不见帧内部")。音频帧跨终端↔大脑
 * 走 `AudioTransport`(接缝 1),也不是总线事件。
 *
 * 模式借 AIRI 纯类型 protocol 包:接口映射 → 派生判别联合,action 与 data 强关联。
 */
import { PROTOCOL_NAME, PROTOCOL_VERSION, type Envelope } from './envelope';

export interface BusEventMap {
  /** 回合生命周期(trace 边界 + cognition 关心)。 */
  'turn:start': { readonly startedAtMs: number };
  'turn:end': { readonly reason: 'completed' | 'interrupted' | 'error'; readonly atMs: number };
  /** 轮次控制信号(粗粒度,非逐帧 VAD)。 */
  'vad:speech_start': { readonly atMs: number };
  'vad:speech_end': { readonly atMs: number };
  /** 完成的转写(粗粒度;partial 是 B 层帧,不在此)。 */
  'stt:final': { readonly text: string };
  /** 首音频延迟标记。 */
  'tts:first_audio': { readonly atMs: number };
  /** 打断控制。 */
  'turn:interrupt': { readonly reason: string };
  /** Provider 故障转移(运维)。 */
  'provider:failover': { readonly domain: string; readonly from: string; readonly to: string };
  // —— 外界交互(§12)新增,纯加法 ——
  /**
   * 感知信号(§12.1):三层去抖后归一的"外界发生了一件值得注意的事"。
   * **只采集不决策**——感知子系统发布,cognition/autonomy 订阅后才决定是否开口。
   * `kind` = `<modality>:<事件名>`(如 `temporal:tick`/`system:notification`),沿用 raw 命名。
   */
  'signal:perception': {
    readonly kind: string;
    /** 人类可读描述(去抖末层描述化,可直接进 context)。 */
    readonly description: string;
    /** 0..1 置信度(聚合窗合并多源后的综合值)。 */
    readonly confidence: number;
    /** 结构化附带数据(原始字段,供下游精确消费)。 */
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
  /** 动作开始执行(§12.2):TaskExecutor 发,带工具名。 */
  'action:started': { readonly name: string; readonly toolCallId: string };
  /** 动作执行成功:content 为回灌下回合 context 的可读结果。 */
  'action:completed': { readonly name: string; readonly toolCallId: string; readonly content: string };
  /** 动作执行失败/被取消:reason 归因可读说明。 */
  'action:failed': {
    readonly name: string;
    readonly toolCallId: string;
    readonly reason: string;
    /** 是否因取消(打断回滚)而失败,便于下游区分。 */
    readonly cancelled?: boolean;
  };
}

export type BusAction = keyof BusEventMap;

/** 判别联合:遍历映射键派生每个 action 对应的强类型信封。 */
export type BusEvent = {
  [A in BusAction]: Envelope<A, BusEventMap[A]>;
}[BusAction];

export function makeBusEvent<A extends BusAction>(
  action: A,
  data: BusEventMap[A],
  correlationId: string,
  code = 0,
): Envelope<A, BusEventMap[A]> {
  return { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, action, code, correlationId, data };
}

/**
 * 单一真相源:`Record<BusAction, true>` 让编译器强制"每个总线事件名都登记"——
 * 给 BusEventMap 加事件却漏登记 → 编译报错(枚举完整性,承 §3.1)。
 */
const ACTION_PRESENCE: Record<BusAction, true> = {
  'turn:start': true,
  'turn:end': true,
  'vad:speech_start': true,
  'vad:speech_end': true,
  'stt:final': true,
  'tts:first_audio': true,
  'turn:interrupt': true,
  'provider:failover': true,
  'signal:perception': true,
  'action:started': true,
  'action:completed': true,
  'action:failed': true,
};

const ACTIONS: ReadonlySet<string> = new Set<string>(Object.keys(ACTION_PRESENCE));

export function isBusAction(x: string): x is BusAction {
  return ACTIONS.has(x);
}

// —— 感知 raw 事件(§12.1)——
//
// raw 事件是**源内**、可能高频的结构化采集,经三层去抖才归一为 `signal:perception` 上 A 层总线。
// 因此 raw **不进 BusEventMap**(避免高频事件污染"粗粒度低频"的 A 层总线 + deepFreeze 成本),
// 但仍以 Envelope 同构建模(action = `raw:<modality>:<kind>`),命名/字段贯穿 trace。
export type PerceptionModality = 'heard' | 'sighted' | 'felt' | 'temporal' | 'system';

/** raw 事件的 action 串形态:`raw:<modality>:<kind>`(供日志/trace 命名)。 */
export type RawAction = `raw:${PerceptionModality}:${string}`;

/**
 * 源内 raw 感知事件(不过早描述化):携带原始结构化数据,而非自然语言。
 * `data.value` 为源自定义的原始负载;`data.atMs` 为事件时间戳(可注入 clock,确定性测试)。
 */
export interface RawPerceptionEvent {
  readonly protocol: typeof PROTOCOL_NAME;
  readonly version: string;
  readonly action: RawAction;
  readonly modality: PerceptionModality;
  readonly kind: string;
  readonly atMs: number;
  /** 原始负载(结构化,源自定义);不在此做描述化。 */
  readonly value: Readonly<Record<string, unknown>>;
}

export function makeRawEvent(
  modality: PerceptionModality,
  kind: string,
  atMs: number,
  value: Readonly<Record<string, unknown>> = {},
): RawPerceptionEvent {
  return {
    protocol: PROTOCOL_NAME,
    version: PROTOCOL_VERSION,
    action: `raw:${modality}:${kind}`,
    modality,
    kind,
    atMs,
    value,
  };
}
