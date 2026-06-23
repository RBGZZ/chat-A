/**
 * VoiceLoop v1 语音回合状态机（单一四态 + 瞬态 barge_in_pending）。
 *
 * 设计依据：`docs/superpowers/specs/2026-06-23-voiceloop-skeleton-design.md` §2。
 * 本模块只描述「状态 + 事件 + 合法迁移」这一纯函数层，无副作用；
 * 编排器（voice-loop.ts）据 `nextState` 推进，并在每次合法迁移时 emit 对应 BusEvent。
 *
 * 设计要点：
 * - `barge_in_pending` 在 v1 进入即解析为真打断（同 tick）；命名态保留，
 *   v2 可在此插入 `false_interruption_timeout` + backchannel 判定而不需重构。
 * - 非法迁移由调用方据 `nextState` 返回 `null` 记 warn 不抛（§3.2 优雅降级）。
 */

/** 语音回合状态：四个稳定态 + 一个瞬态打断判定态。 */
export type VoiceState =
  | 'listening'
  | 'endpointing'
  | 'thinking'
  | 'speaking'
  | 'barge_in_pending';

/** 驱动状态迁移的总线事件（§4.2.1 BusEvents 子集）。 */
export type VoiceBusEvent =
  | 'vad:speech_start'
  | 'vad:speech_end'
  | 'stt:final'
  | 'tts:first_audio'
  | 'turn:end'
  | 'turn:interrupt';

/**
 * 合法迁移表（spec §2）。
 * 外层键为「源状态」，内层键为「触发事件」，值为「目标状态」；
 * 表中不存在的 (状态, 事件) 组合即非法迁移。
 */
export const VOICE_TRANSITIONS: Record<
  VoiceState,
  Partial<Record<VoiceBusEvent, VoiceState>>
> = {
  listening: {
    'vad:speech_start': 'endpointing', // 检出语音起点，开始累积音频帧
  },
  endpointing: {
    'stt:final': 'thinking', // EOU 判「说完」→ STT 转写 → 触发 send
    'vad:speech_end': 'listening', // 长时静音/无语音放弃，丢弃累积
  },
  thinking: {
    'tts:first_audio': 'speaking', // 首句 TTS 音频就绪
  },
  speaking: {
    'turn:end': 'listening', // 播放排空（send 完成且 TTS 出尽）
    'vad:speech_start': 'barge_in_pending', // SPEAKING 中检出语音 → 进入打断判定
  },
  barge_in_pending: {
    'turn:interrupt': 'listening', // v1 即时判真 → 执行打断后回 listening
  },
};

/**
 * 查表推进状态：合法迁移返回目标态，非法返回 `null`。
 * 调用方据此 emit BusEvent / 记 warn（不抛，承 §3.2）。
 */
export function nextState(
  from: VoiceState,
  event: VoiceBusEvent,
): VoiceState | null {
  return VOICE_TRANSITIONS[from][event] ?? null;
}
