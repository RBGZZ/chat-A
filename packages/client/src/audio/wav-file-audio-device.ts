/**
 * `WavFileAudioDevice` —— 无原生依赖的「文件音频设备」(承「填 key 即测」目标 / §3.2 优雅降级)。
 *
 * 实现既有 {@link AudioDevice} 接缝,与 Fake/Node 平级,但**两头都接真音频文件**:
 *   - **采集(假麦克风)**:从 16kHz/mono/s16le 的 WAV(或直接注入的 {@link PcmFrame}[])逐帧回放给 `onFrame`,
 *     带递增 `timestampMs`(按 10ms/帧步进,供 VAD/EOU 时间对齐)。可喂真录音给云 STT 测全语音链路。
 *   - **播放(假扬声器)**:`play` 把 TTS 下行 Int16 块累积到内存;`close`/`flush` 时编码成 WAV 写文件,
 *     可离线试听云 TTS 产出。
 *
 * **纯 `node:fs` + JS WAV 编解码**(见 wav.ts),零原生依赖、可注入、可测。
 * 回放用注入式 `schedule`(缺省 `setTimeout(…,0)` 排队),非阻塞、不引真时钟;`close` 后所有方法安全 no-op。
 */
import { Buffer } from 'node:buffer';
import { readFileSync, writeFileSync } from 'node:fs';
import {
  SAMPLE_RATE_HZ,
  CHANNELS,
  SAMPLES_PER_FRAME,
  FRAME_MS,
  type PcmFrame,
} from '@chat-a/protocol';
import type { AudioDevice, CaptureListener, PlaybackChunk, StopCapture } from './audio-device';
import { decodeWav, encodeWavBuffer } from './wav';

/** 注入式排程(确定性测试用);缺省 `setTimeout(cb, 0)`。 */
export type ScheduleFn = (cb: () => void) => void;

export interface WavFileAudioDeviceOptions {
  /** 输入 WAV 路径(假麦克风);须 16k/mono/s16le。与 `inputFrames` 二选一(都给以 inputFrames 优先)。 */
  readonly inputWavPath?: string;
  /** 直接注入采集帧序列(测试免落盘);优先于 inputWavPath。 */
  readonly inputFrames?: readonly PcmFrame[];
  /** 输出 WAV 路径(假扬声器);省略则只留内存缓冲(供断言),不落盘。 */
  readonly outputWavPath?: string;
  /** 回放排程(缺省 setTimeout 0);注入以做确定性测试。 */
  readonly schedule?: ScheduleFn;
  /** 起始时间戳(ms);缺省 0,逐帧 +10ms。 */
  readonly startTimestampMs?: number;
}

const DEFAULT_SCHEDULE: ScheduleFn = (cb) => setTimeout(cb, 0);

export class WavFileAudioDevice implements AudioDevice {
  readonly id = 'wav';

  /** 累积的全部播放样本(按到达顺序拼接);测试据此断言下行 TTS。 */
  readonly playedSamples: number[] = [];
  /** `playStop` 被调用次数(打断校验)。 */
  playStopCount = 0;

  readonly #inputFrames: readonly PcmFrame[];
  readonly #outputWavPath: string | undefined;
  readonly #schedule: ScheduleFn;
  /** 播放采样率(取首个块的采样率;TTS 常 24k)。 */
  #playSampleRate = 24_000;
  #onFrame: CaptureListener | null = null;
  #closed = false;

  constructor(opts: WavFileAudioDeviceOptions = {}) {
    this.#outputWavPath = opts.outputWavPath;
    this.#schedule = opts.schedule ?? DEFAULT_SCHEDULE;
    const start = opts.startTimestampMs ?? 0;
    if (opts.inputFrames !== undefined) {
      this.#inputFrames = opts.inputFrames;
    } else if (opts.inputWavPath !== undefined) {
      this.#inputFrames = framesFromWavFile(opts.inputWavPath, start);
    } else {
      this.#inputFrames = []; // 无输入:采集空(只测下行播放时合法)。
    }
  }

  captureStart(onFrame: CaptureListener): StopCapture {
    if (this.#closed) return () => {};
    this.#onFrame = onFrame;
    // 逐帧异步回放(经注入 schedule,非阻塞);每拍发一帧,期间被 close/停采集则中止。
    const frames = this.#inputFrames;
    let i = 0;
    const pump = (): void => {
      if (this.#onFrame === null || this.#closed) return;
      if (i >= frames.length) return;
      const f = frames[i++]!;
      try {
        this.#onFrame(f);
      } catch {
        // 上行回调抛错不崩设备(§3.2),丢这一帧继续。
      }
      this.#schedule(pump);
    };
    this.#schedule(pump);
    return () => {
      this.#onFrame = null;
    };
  }

  play(chunk: PlaybackChunk): void {
    if (this.#closed) return;
    this.#playSampleRate = chunk.sampleRate;
    for (const s of chunk.samples) this.playedSamples.push(s);
  }

  playStop(): void {
    if (this.#closed) return;
    this.playStopCount++;
  }

  /** 把当前累积的播放样本编码为 WAV 写出(若设了 outputWavPath);返回 WAV 字节(便于断言/脚本复用)。 */
  flush(): Uint8Array | undefined {
    if (this.playedSamples.length === 0) return undefined;
    const wav = encodeWavBuffer(Int16Array.from(this.playedSamples), this.#playSampleRate, CHANNELS);
    if (this.#outputWavPath !== undefined) {
      try {
        writeFileSync(this.#outputWavPath, wav);
      } catch {
        // 落盘失败不崩(§3.2);内存缓冲仍可被读取。
      }
    }
    return wav;
  }

  close(): void {
    if (this.#closed) return;
    // 关闭前把累积播放产出落盘(假扬声器最终产物)。
    this.flush();
    this.#closed = true;
    this.#onFrame = null;
  }
}

/** 读 WAV 文件 → 切成 160 样本/10ms 帧(断言 16k/mono/s16le);带递增时间戳。 */
function framesFromWavFile(path: string, startTimestampMs: number): PcmFrame[] {
  const bytes = new Uint8Array(readFileSync(path) as Buffer);
  const { samples, sampleRate, channels } = decodeWav(bytes);
  if (sampleRate !== SAMPLE_RATE_HZ) {
    throw new Error(
      `WAV 采集要求 16kHz,实际 ${sampleRate}Hz;请提供 16k/mono/s16le 的 WAV(本设备不内置重采样)。`,
    );
  }
  if (channels !== CHANNELS) {
    throw new Error(`WAV 采集要求单声道(mono),实际 ${channels} 声道。`);
  }
  return framesFromSamples(samples, startTimestampMs);
}

/** Int16 样本序列 → PcmFrame[](160 样本/帧,时间戳逐帧 +10ms;尾部不足一帧补零)。 */
export function framesFromSamples(samples: Int16Array, startTimestampMs = 0): PcmFrame[] {
  const frames: PcmFrame[] = [];
  let ts = startTimestampMs;
  for (let off = 0; off < samples.length; off += SAMPLES_PER_FRAME) {
    const slice = samples.subarray(off, off + SAMPLES_PER_FRAME);
    const frame =
      slice.length === SAMPLES_PER_FRAME ? Int16Array.from(slice) : padToFrame(slice);
    frames.push({ samples: frame, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs: ts });
    ts += FRAME_MS;
  }
  return frames;
}

function padToFrame(slice: Int16Array): Int16Array {
  const out = new Int16Array(SAMPLES_PER_FRAME);
  out.set(slice, 0);
  return out;
}
