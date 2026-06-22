/**
 * 事件契约(承 AIRI 纯类型 protocol 包模式):接口映射 → 派生判别联合,
 * `action` 与 `data` 端到端强关联。模块只依赖此契约,不 import 别模块内部实现(§3.1)。
 */
import { PROTOCOL_NAME, PROTOCOL_VERSION, type Envelope } from './envelope';
import type { PcmFrame } from './pcm';

export interface ProtocolEventMap {
  'audio:chunk': PcmFrame;
  'vad:speech_start': { readonly atMs: number };
  'vad:speech_end': { readonly atMs: number };
  'stt:partial': { readonly text: string };
  'stt:final': { readonly text: string };
  'llm:token': { readonly text: string };
  'tts:chunk': { readonly frame: PcmFrame };
  'tts:first_audio': { readonly atMs: number };
  'turn:interrupt': { readonly reason: string };
  'provider:failover': { readonly domain: string; readonly from: string; readonly to: string };
}

export type ProtocolAction = keyof ProtocolEventMap;

/** 判别联合:遍历映射键派生每个 action 对应的强类型信封。 */
export type ProtocolEvent = {
  [A in ProtocolAction]: Envelope<A, ProtocolEventMap[A]>;
}[ProtocolAction];

export function makeEvent<A extends ProtocolAction>(
  action: A,
  data: ProtocolEventMap[A],
  correlationId: string,
  code = 0,
): Envelope<A, ProtocolEventMap[A]> {
  return { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, action, code, correlationId, data };
}

const ACTIONS: ReadonlySet<string> = new Set<ProtocolAction>([
  'audio:chunk',
  'vad:speech_start',
  'vad:speech_end',
  'stt:partial',
  'stt:final',
  'llm:token',
  'tts:chunk',
  'tts:first_audio',
  'turn:interrupt',
  'provider:failover',
]);

export function isProtocolAction(x: string): x is ProtocolAction {
  return ACTIONS.has(x);
}
