/**
 * 送 ASR 前段级语音门（防 ASR 静音幻觉 Layer 2,主力）。
 *
 * 背景:能量 VAD 被噪声尖峰误触发 → endpointing 把几帧静音整段喂 qwen-asr → ASR 幻觉出「嗯/thank you」。
 * qwen-asr **无任何 no-speech/VAD API 参数**,只能前置拦截。本门是「送 ASR 前」的最后一道纯函数闸:
 * 段够长 **且** 含足够「有声帧」才放行送 ASR,否则判伪段丢弃(不送 ASR,静默回 listening)。
 *
 * 设计要点:用「有声帧累计时长」而非段均 RMS 判内容——后者被尾静音稀释,前者鲁棒:
 *   - 噪声尖峰(1~2 帧高 RMS + 大量静音)→ 有声时长 < 门槛 → 拦。
 *   - 纯静音(0 有声帧)→ 拦。
 *   - 真语音(>100ms 有声)→ 轻松通过。
 * 纯函数、无状态、确定性可测;复用既有归一 RMS(与 VAD 进入阈同口径)。
 */
import type { PcmFrame } from '@chat-a/protocol';
import { normalizedRms } from './energy-vad'; // 复用现成归一RMS(与 VAD 进入阈同口径)

export interface SpeechGateConfig {
  /** 段总时长须 ≥ 此值(ms),否则判伪段丢弃。 */
  readonly minSpeechMs: number;
  /** 帧归一RMS ≥ 此值算「有声帧」(复用 VAD 进入阈)。 */
  readonly voicedRmsThreshold: number;
  /** 「有声帧」累计时长须 ≥ 此值(ms),否则判无真语音内容丢弃。 */
  readonly minVoicedMs: number;
  /** Int16 满量程(归一分母)。 */
  readonly fullScale: number;
}

export const DEFAULT_SPEECH_GATE_CONFIG: SpeechGateConfig = {
  minSpeechMs: 300,
  voicedRmsThreshold: 0.02,
  minVoicedMs: 100,
  fullScale: 32768,
};

/**
 * 段级语音门:段够长 且 含足够「有声帧」才放行送 ASR。
 * 用「有声帧累计时长」而非段均RMS(后者被尾静音稀释)——噪声尖峰(1-2帧)/纯静音(0帧)必被拦,
 * 真语音(>100ms 有声)轻松通过。返回 true=放行。
 */
export function passesSpeechGate(frames: readonly PcmFrame[], cfg: SpeechGateConfig): boolean {
  if (frames.length === 0) return false;
  let totalMs = 0;
  let voicedMs = 0;
  for (const f of frames) {
    const ms = (f.samples.length / f.sampleRate) * 1000;
    totalMs += ms;
    if (normalizedRms(f.samples, cfg.fullScale) >= cfg.voicedRmsThreshold) voicedMs += ms;
  }
  return totalMs >= cfg.minSpeechMs && voicedMs >= cfg.minVoicedMs;
}
