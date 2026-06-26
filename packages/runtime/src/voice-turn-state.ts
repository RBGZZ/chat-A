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

/**
 * 语音回合状态：四个稳定态 + 两个瞬态判定态。
 * - `committing`（瞬态忙，回合并发竞态修复）：批式路在 `await 转写` **之前**先迁入此态，
 *   关死 endpointing 的重入窗——期间 `#onAudio` 不再累积音频/判 EOU，从源头消除并发起第二个回合
 *   （单回合守卫 single-flight）。转写回来 `stt:final` 进 thinking；空/失败/超越则 `vad:speech_end` 回 listening。
 *   语义上等同「endpointing 末尾的瞬态忙」，不破坏现有 4 稳定态语义（isSpeaking 等只认 speaking）。
 */
export type VoiceState =
  | 'listening'
  | 'endpointing'
  | 'committing'
  | 'thinking'
  | 'speaking'
  | 'barge_in_pending';

/**
 * 驱动状态迁移的总线事件（§4.2.1 BusEvents 子集）。
 * `eou`：内部「断句确认」事件（endpointing→committing），**不**桥接为对外 protocol BusEvent
 * （committing 为内部瞬态忙，无外部消费者）；仅经状态机推进 + trace `state` 事件可见。
 */
export type VoiceBusEvent =
  | 'vad:speech_start'
  | 'vad:speech_end'
  | 'stt:final'
  | 'tts:first_audio'
  | 'turn:end'
  | 'turn:interrupt'
  | 'eou';

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
    // EOU 判「说完」→ 取转写 → 触发「想」。转写来源有二，迁移语义相同（故复用同一事件，不新增态）：
    //   STT 路径=STT final 文本；omni audio-in 直路（path B）=omni 的 transcript 事件文本。
    // 批式路（#startThinking/#startThinkingOmni）先经 `eou` 迁入 committing（关重入窗）再 `stt:final`；
    // 连续流式路（#runStreamTurn→#runTurn）无本地转写 await，故仍直达 endpointing→thinking。
    'eou': 'committing', // 断句确认 → 瞬态忙(批式 await 转写前先迁入,单回合守卫)
    'stt:final': 'thinking',
    'vad:speech_end': 'listening', // 长时静音/无语音放弃，丢弃累积
  },
  committing: {
    'stt:final': 'thinking', // 转写定稿 → 起「想」
    'vad:speech_end': 'listening', // 空转写/转写失败/被超越 → 干净回 listening
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
