/**
 * 语音 Provider 的音频块表示(承 §4.1/§4.3 + protocol/pcm.ts 硬约定)。
 *
 * 为什么不直接用 protocol 的 `PcmFrame`:
 * - `PcmFrame` 锁定 16kHz / 10ms / 带 `timestampMs`,服务于 runtime 帧管线的 EOU/打断时间对齐;
 * - STT 入口确为 16kHz mono s16le,但 TTS 出口常见 24kHz(Kokoro/OpenAI pcm),采样率必须可变;
 * - STT/TTS 的块只是"一段连续 PCM",不需要逐帧时间戳(那是 runtime 的职责)。
 * 故这里定义更松的 `PcmChunk`(samples + sampleRate + channels),复用 protocol 的字节常量做换算,
 * **不依赖尚不存在的 Frame 类型**(任务硬约束)。runtime 串接时可在边界把 PcmFrame ↔ PcmChunk 互转。
 *
 * 佐证(真实音频格式):
 * - STT 16kHz mono Int16:reference/github-projects/realtime-voice-agent-demo/.../backend/app/adapters/stt/base.py
 *   (SAMPLE_RATE=16000 / SAMPLE_WIDTH=2 / CHANNELS=1);Open-LLM-VTuber asr_interface.py(NUM_CHANNELS=1/SAMPLE_WIDTH=2)。
 * - TTS 24kHz mono Int16:reference/.../projectBEA/.../kokoro_tts_wrapper.py(返回 sample_rate=24000);
 *   reference/Nexus-full/.../electron/services/ttsService.js(OpenAI-compat pcm → 24kHz mono int16)。
 */
import { SAMPLE_RATE_HZ, CHANNELS, SAMPLE_BYTES } from '@chat-a/protocol';

/** STT 输入采样率(16kHz,Whisper 系硬约定;= protocol SAMPLE_RATE_HZ)。 */
export const STT_SAMPLE_RATE_HZ = SAMPLE_RATE_HZ; // 16_000
/** TTS 输出常见采样率(24kHz,Kokoro/OpenAI pcm 默认)。 */
export const TTS_SAMPLE_RATE_HZ = 24_000;

/**
 * 一段连续 PCM(Int16 / 交错;mono 时即单声道样本序列)。
 * `samples` 已是 Int16(s16le 解码后);`sampleRate`/`channels` 显式带上以便跨采样率(16k 入 / 24k 出)。
 */
export interface PcmChunk {
  readonly samples: Int16Array;
  /** 采样率(Hz):STT 入常为 16000,TTS 出常为 24000。 */
  readonly sampleRate: number;
  /** 声道数:语音链路恒为 1(mono);保留字段以便日后扩展。 */
  readonly channels: number;
}

/** 构造一个 mono PcmChunk(默认 channels=1)。 */
export function pcmChunk(samples: Int16Array, sampleRate: number, channels = CHANNELS): PcmChunk {
  return { samples, sampleRate, channels };
}

/** 该 PcmChunk 的原始字节数(Int16 → 每样本 SAMPLE_BYTES=2)。 */
export function chunkByteLength(chunk: PcmChunk): number {
  return chunk.samples.length * SAMPLE_BYTES;
}

/** 该 PcmChunk 的时长(ms);用于桩/测试校验产出"听起来有多长"。 */
export function chunkDurationMs(chunk: PcmChunk): number {
  const frames = chunk.samples.length / Math.max(1, chunk.channels);
  return (frames / chunk.sampleRate) * 1000;
}
