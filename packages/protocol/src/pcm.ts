/**
 * 音频硬约定(承 §1/§4):PCM Int16 / 16kHz / mono。
 * 10ms 切片是"播放中途干净打断"的物理前提(voice-infra 深读);逐帧带时间戳
 * 用于 EOU/打断的时间对齐(裸 WebSocket 必须自带,LiveKit 靠 WebRTC 白嫖)。
 */
export const SAMPLE_RATE_HZ = 16_000;
export const CHANNELS = 1;
export const SAMPLE_BYTES = 2; // Int16
export const FRAME_MS = 10;
export const SAMPLES_PER_FRAME = (SAMPLE_RATE_HZ * FRAME_MS) / 1000; // 160
export const BYTES_PER_FRAME = SAMPLES_PER_FRAME * SAMPLE_BYTES * CHANNELS; // 320

export interface PcmFrame {
  readonly samples: Int16Array;
  readonly sampleRate: number;
  readonly channels: number;
  /** 该帧对应的真实时刻(ms),非协程恢复时刻。 */
  readonly timestampMs: number;
}

/** 给定毫秒数对应的 PCM 字节数(16k mono Int16)。 */
export function bytesForMs(ms: number): number {
  return Math.round((SAMPLE_RATE_HZ * ms) / 1000) * SAMPLE_BYTES * CHANNELS;
}
