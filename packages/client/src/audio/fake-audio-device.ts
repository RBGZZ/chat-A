/**
 * `FakeAudioDevice` —— 确定性音频设备桩(承 §3.2 可测试性;对应 FakeLlm/FakeStt 在各接缝的角色)。
 *
 * 无原生依赖 / 离线 / 单测用。行为完全确定:
 * - **采集**:`captureStart` 把注入的帧序列(`script`)逐帧回放给 `onFrame`(同步、即时);
 *   `emit` 还可手动追加帧(测试想精确控制时序时用)。停采集后不再回放。
 * - **播放**:`play` 把收到的块**原样记录**到 {@link played} 供断言;`playStop` 记一次停止并清「当前段」。
 *
 * 不引真时钟/真音频/真原生库,故可在任何环境跑通 VoiceLoop 闭环逻辑测试。
 */
import type { PcmFrame } from '@chat-a/protocol';
import type { AudioDevice, CaptureListener, PlaybackChunk, StopCapture } from './audio-device';

export interface FakeAudioDeviceOptions {
  /** 采集回放的帧序列;`captureStart` 时逐帧同步回放(可空,之后用 `emit` 手动喂)。 */
  readonly script?: readonly PcmFrame[];
}

export class FakeAudioDevice implements AudioDevice {
  readonly id = 'fake';

  /** 收到的全部播放块(按到达顺序);测试据此断言「下行 TTS 是否到了扬声器」。 */
  readonly played: PlaybackChunk[] = [];
  /** `playStop` 被调用的次数(打断校验)。 */
  playStopCount = 0;

  readonly #script: readonly PcmFrame[];
  #onFrame: CaptureListener | null = null;
  #closed = false;

  constructor(opts: FakeAudioDeviceOptions = {}) {
    this.#script = opts.script ?? [];
  }

  captureStart(onFrame: CaptureListener): StopCapture {
    if (this.#closed) return () => {};
    this.#onFrame = onFrame;
    // 同步回放注入的脚本帧(确定性:无需真时钟/异步排程)。
    for (const f of this.#script) {
      if (this.#onFrame === null) break; // 回放途中被停
      this.#onFrame(f);
    }
    return () => {
      this.#onFrame = null;
    };
  }

  /** 手动追加一帧麦克风音频(仅在已 `captureStart` 且未停时生效);测试精确控时序用。 */
  emit(frame: PcmFrame): void {
    if (this.#closed) return;
    this.#onFrame?.(frame);
  }

  play(chunk: PlaybackChunk): void {
    if (this.#closed) return;
    this.played.push(chunk);
  }

  playStop(): void {
    if (this.#closed) return;
    this.playStopCount++;
  }

  close(): void {
    this.#closed = true;
    this.#onFrame = null;
  }
}
