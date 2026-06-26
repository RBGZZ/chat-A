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

/** 段级语音门的标量度量(段总时长 + 有声帧累计时长,ms)。批式/流式都收敛到这两个标量。 */
export interface SpeechGateMeasure {
  readonly totalMs: number;
  readonly voicedMs: number;
}

/**
 * 段级语音门的**标量谓词**——批式(passesSpeechGate)与流式(逐帧增量累计)共用的**单一真相源**。
 * 段够长(totalMs ≥ minSpeechMs)**且**有声帧累计够长(voicedMs ≥ minVoicedMs)才放行(true)。
 * 纯标量、无帧依赖:流式路据此「只数两个标量」而非 buffer 整段 PCM(树莓派友好)。
 */
export function meetsSpeechGate(m: SpeechGateMeasure, cfg: SpeechGateConfig): boolean {
  return m.totalMs >= cfg.minSpeechMs && m.voicedMs >= cfg.minVoicedMs;
}

/**
 * 段级语音门:段够长 且 含足够「有声帧」才放行送 ASR。
 * 用「有声帧累计时长」而非段均RMS(后者被尾静音稀释)——噪声尖峰(1-2帧)/纯静音(0帧)必被拦,
 * 真语音(>100ms 有声)轻松通过。返回 true=放行。
 * **等价重构**:汇总 `{totalMs,voicedMs}` 后喂标量谓词 `meetsSpeechGate`(与流式共用真相源,行为字面不变)。
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
  return meetsSpeechGate({ totalMs, voicedMs }, cfg);
}
