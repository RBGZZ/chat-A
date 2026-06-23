/**
 * 接缝:`AudioDevice` —— 终端侧**真音频 I/O 设备**抽象(R2 隔离切片)。
 *
 * 职责边界(承 §2 拓扑「终端」侧 / §4.2 B 层音频帧):
 *   - 采集:麦克风 → 16kHz / mono / s16le 的 {@link PcmFrame}(对齐 STT 输入硬约定,见 protocol/pcm.ts)。
 *   - 播放:把 TTS 下行块(24kHz / mono Int16)送到扬声器。
 * 它**不感知** transport / VoiceLoop / STT / TTS —— 只管「拿到麦克风帧」与「播放音频块」,
 * 经 cli 装配层桥接到 {@link InProcessAudioTransport}(见 voice-runner.ts)。这是隔离接缝:
 * 换设备实现(Fake↔真原生库)消费者零改动(§3.1),真原生库装不上也能用 Fake 跑通逻辑/测试。
 *
 * 为何用 protocol 的 PcmFrame 而非 providers 的 PcmChunk:
 *   采集侧产出的就是「逐帧、带真实时刻」的麦克风帧,正是 runtime EOU/打断时间对齐所需(§4.2)。
 *   播放侧只需「一段连续 PCM + 采样率」,故 {@link play} 收更松的 {@link PlaybackChunk}。
 */
import type { PcmFrame } from '@chat-a/protocol';

/** 注销采集:{@link AudioDevice.captureStart} 返回此函数,调用即停止麦克风采集。幂等。 */
export type StopCapture = () => void;

/** 收到一帧麦克风音频时的回调(16kHz / mono / s16le)。 */
export type CaptureListener = (frame: PcmFrame) => void;

/**
 * 待播放的音频块(扬声器入参):一段连续 Int16 PCM + 采样率 + 声道。
 * 与 providers 的 `PcmChunk` 同构,但 client 不直接依赖 providers 的内部块类型,
 * 故在此定义最小播放契约(TTS 下行帧经 cli 装配层转成它)。
 */
export interface PlaybackChunk {
  readonly samples: Int16Array;
  /** 采样率(Hz):TTS 下行常为 24000。 */
  readonly sampleRate: number;
  /** 声道数:语音链路恒 mono(=1)。 */
  readonly channels: number;
}

/**
 * 终端音频设备接缝(最小面)。所有方法在 {@link close} 之后应为安全 no-op(优雅降级,§3.2:永不崩)。
 */
export interface AudioDevice {
  /** 设备标识(仅供状态行/日志,如 'fake' / 'node:naudiodon');业务不据此分支。 */
  readonly id: string;

  /**
   * 启动麦克风采集:每采到一帧(16kHz / mono / s16le)即回调 `onFrame`。
   * 返回停止采集的函数(幂等);重复 `captureStart` 由实现自行处理(应先停旧的)。
   */
  captureStart(onFrame: CaptureListener): StopCapture;

  /** 播放一块 TTS 音频(追加到扬声器输出);`close`/`playStop` 后为安全 no-op。 */
  play(chunk: PlaybackChunk): void;

  /** 停止/排空当前扬声器播放(打断时用);幂等、`close` 后为安全 no-op。 */
  playStop(): void;

  /** 关闭设备:停采集、停播放、释放底层资源。幂等。 */
  close(): void;
}
