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
};

const ACTIONS: ReadonlySet<string> = new Set<string>(Object.keys(ACTION_PRESENCE));

export function isBusAction(x: string): x is BusAction {
  return ACTIONS.has(x);
}
