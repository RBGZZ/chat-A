/**
 * `NodeAudioDevice` —— 真音频 I/O 设备骨架(PC 优先;真行为留用户 PC 手测)。
 *
 * **关键约束(R2 隔离切片)**:本文件**不**把任何原生音频库写进 client 的 dependencies,
 * 也**不**在本环境跑真麦克风/扬声器。原生库经**动态 import + 鸭子类型**在运行时按需加载;
 * 装不上时 `init()` 抛**明确报错**(提示装哪个包),绝不静默崩。
 *
 * 选用 `naudiodon`(PortAudio 绑定,单包同时给「麦克风输入流」「扬声器输出流」,跨平台 PC):
 *   - 输入:`AudioIO({ inOptions })` 返回一个 Node Readable,持续吐 PCM Buffer;
 *   - 输出:`AudioIO({ outOptions })` 返回一个 Node Writable,`write(buffer)` 即播放。
 * 桥接:输入 Buffer(s16le 字节)→ 切成 160 样本/10ms 帧 → {@link PcmFrame}(回调 onFrame);
 *       {@link play} 的 Int16 块 → s16le Buffer → 写入输出流。
 *
 * 鸭子类型:我们只假定库导出一个可调用的 `AudioIO`(或 default),返回对象具备
 * Readable/Writable 的 `on('data')`/`write`/`quit|destroy|end` 子集 —— 不强依赖具体类型声明,
 * 故无需 `@types/naudiodon`。换 `mic`/`speaker` 等库时改 {@link createNativeIo} 一处即可。
 *
 * 采样率:采集 16kHz / mono / s16le(STT 硬约定);播放按块自带的 `sampleRate`(TTS 常 24kHz)。
 * 若所选库不支持运行时改采样率,需为输出固定一档(此处骨架按首个块的采样率开流;真接入时按库能力调整)。
 */
import { Buffer } from 'node:buffer';
import {
  SAMPLE_RATE_HZ,
  CHANNELS,
  SAMPLE_BYTES,
  SAMPLES_PER_FRAME,
  type PcmFrame,
} from '@chat-a/protocol';
import type { AudioDevice, CaptureListener, PlaybackChunk, StopCapture } from './audio-device';

/** 默认要动态加载的原生库模块名(可经构造参数覆盖)。 */
const DEFAULT_NATIVE_MODULE = 'naudiodon';

/** 鸭子类型:一个「音频流」对端的最小面(输入 Readable / 输出 Writable 的交集子集)。 */
interface NativeStream {
  on?(event: string, cb: (...args: unknown[]) => void): unknown;
  write?(chunk: Buffer): unknown;
  start?(): unknown;
  quit?(cb?: () => void): unknown;
  destroy?(): unknown;
  end?(): unknown;
}

/** 鸭子类型:库导出的工厂(`AudioIO` 或 default)。入参形状贴 naudiodon。 */
type NativeAudioIoFactory = (opts: {
  readonly inOptions?: Record<string, unknown>;
  readonly outOptions?: Record<string, unknown>;
}) => NativeStream;

export interface NodeAudioDeviceOptions {
  /** 要动态 import 的原生模块名;缺省 `naudiodon`。装别的库(mic/speaker)时换它 + 改 createNativeIo。 */
  readonly nativeModule?: string;
  /** 采集采样率(Hz);缺省 16000(STT 硬约定)。 */
  readonly captureSampleRate?: number;
  /** 播放采样率(Hz);缺省 24000(TTS 常见)。真库不支持动态改时按此开输出流。 */
  readonly playbackSampleRate?: number;
  /** 设备号(PortAudio deviceId;-1 = 默认设备)。 */
  readonly deviceId?: number;
}

export class NodeAudioDevice implements AudioDevice {
  readonly id: string;

  readonly #nativeModule: string;
  readonly #captureRate: number;
  readonly #playbackRate: number;
  readonly #deviceId: number;

  /** 动态加载到的工厂(init 后就位)。 */
  #factory: NativeAudioIoFactory | null = null;
  #inStream: NativeStream | null = null;
  #outStream: NativeStream | null = null;
  #closed = false;
  /** 采集字节缓冲:攒够 320 字节(160 样本)切一帧。 */
  #pending: Buffer = Buffer.alloc(0);

  constructor(opts: NodeAudioDeviceOptions = {}) {
    this.#nativeModule = opts.nativeModule ?? DEFAULT_NATIVE_MODULE;
    this.#captureRate = opts.captureSampleRate ?? SAMPLE_RATE_HZ;
    this.#playbackRate = opts.playbackSampleRate ?? 24_000;
    this.#deviceId = opts.deviceId ?? -1;
    this.id = `node:${this.#nativeModule}`;
  }

  /**
   * 动态加载原生库(必须在 captureStart/play 前 await 一次)。
   * 装不上 → 抛**明确报错**(提示安装),不静默降级(让 cli 装配层据此回落 Fake 或报错退出)。
   */
  async init(): Promise<void> {
    if (this.#factory !== null) return;
    let mod: unknown;
    try {
      // 动态 import:模块名经变量,避免被打包器静态解析 / 写进依赖图。
      mod = await import(/* @vite-ignore */ this.#nativeModule);
    } catch (err) {
      throw new Error(
        `未能加载原生音频库 "${this.#nativeModule}":请先安装(如 \`pnpm add -w ${this.#nativeModule}\`,` +
          `需本机有 C++ 构建工具链);或改用 Fake 设备/文字模式。原始错误:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const factory = pickAudioIoFactory(mod);
    if (factory === null) {
      throw new Error(
        `原生音频库 "${this.#nativeModule}" 已加载,但未找到可用的 AudioIO 工厂(导出形状不符);` +
          `若用的不是 naudiodon,请改写 client/src/audio/node-audio-device.ts 的 createNativeIo 桥接。`,
      );
    }
    this.#factory = factory;
  }

  captureStart(onFrame: CaptureListener): StopCapture {
    if (this.#closed) return () => {};
    if (this.#factory === null) {
      throw new Error('NodeAudioDevice 未初始化:请先 await device.init()(动态加载原生库)。');
    }
    this.#stopCapture(); // 幂等:先停旧的
    this.#pending = Buffer.alloc(0);
    const stream = this.#factory({
      inOptions: {
        channelCount: CHANNELS,
        sampleFormat: 16, // s16le(naudiodon SampleFormat16Bit=16)
        sampleRate: this.#captureRate,
        deviceId: this.#deviceId,
        closeOnError: false,
      },
    });
    this.#inStream = stream;
    // 鸭子类型:naudiodon 的输入流是 Readable,on('data', Buffer) 持续吐 s16le 字节。
    stream.on?.('data', (...args: unknown[]) => {
      const buf = args[0];
      if (Buffer.isBuffer(buf)) this.#onCaptureBytes(buf, onFrame);
    });
    stream.start?.();
    return () => this.#stopCapture();
  }

  /** 攒字节 → 满 320 字节(160 样本)切一帧 PcmFrame,带 wall-clock 时刻喂 onFrame。 */
  #onCaptureBytes(buf: Buffer, onFrame: CaptureListener): void {
    if (this.#closed) return;
    this.#pending = this.#pending.length === 0 ? buf : Buffer.concat([this.#pending, buf]);
    const frameBytes = SAMPLES_PER_FRAME * SAMPLE_BYTES; // 320
    let offset = 0;
    while (this.#pending.length - offset >= frameBytes) {
      const slice = this.#pending.subarray(offset, offset + frameBytes);
      const samples = new Int16Array(SAMPLES_PER_FRAME);
      for (let i = 0; i < SAMPLES_PER_FRAME; i++) samples[i] = slice.readInt16LE(i * SAMPLE_BYTES);
      const frame: PcmFrame = {
        samples,
        sampleRate: this.#captureRate,
        channels: CHANNELS,
        timestampMs: Date.now(),
      };
      try {
        onFrame(frame);
      } catch {
        // 上行回调抛错不应崩设备(§3.2);丢这一帧继续。
      }
      offset += frameBytes;
    }
    this.#pending = offset > 0 ? Buffer.from(this.#pending.subarray(offset)) : this.#pending;
  }

  play(chunk: PlaybackChunk): void {
    if (this.#closed) return;
    if (this.#factory === null) return; // 未初始化时静默 no-op(优雅降级)
    if (this.#outStream === null) this.#openOutput();
    const out = this.#outStream;
    if (out?.write === undefined) return;
    // Int16Array → s16le Buffer(小端)。
    const buf = Buffer.alloc(chunk.samples.length * SAMPLE_BYTES);
    for (let i = 0; i < chunk.samples.length; i++) buf.writeInt16LE(chunk.samples[i] ?? 0, i * SAMPLE_BYTES);
    try {
      out.write(buf);
    } catch {
      // 写入失败不崩(设备拔出等);下次 play 再试。
    }
  }

  #openOutput(): void {
    if (this.#factory === null) return;
    const stream = this.#factory({
      outOptions: {
        channelCount: CHANNELS,
        sampleFormat: 16, // s16le
        sampleRate: this.#playbackRate,
        deviceId: this.#deviceId,
        closeOnError: false,
      },
    });
    this.#outStream = stream;
    stream.start?.();
  }

  playStop(): void {
    if (this.#closed) return;
    // 真排空依库而定:naudiodon 重开输出流即丢未播缓冲。骨架:关旧输出流,下次 play 重开。
    this.#closeStream(this.#outStream);
    this.#outStream = null;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#stopCapture();
    this.#closeStream(this.#outStream);
    this.#outStream = null;
    this.#factory = null;
  }

  #stopCapture(): void {
    this.#closeStream(this.#inStream);
    this.#inStream = null;
    this.#pending = Buffer.alloc(0);
  }

  /** 尽力关闭一个原生流(quit/destroy/end 任一可用);全程吞错,绝不抛。 */
  #closeStream(stream: NativeStream | null): void {
    if (stream === null) return;
    try {
      if (typeof stream.quit === 'function') stream.quit();
      else if (typeof stream.destroy === 'function') stream.destroy();
      else if (typeof stream.end === 'function') stream.end();
    } catch {
      /* 关闭失败不致命 */
    }
  }
}

/**
 * 从动态 import 的模块里挑出 AudioIO 工厂(鸭子类型容错):
 * naudiodon 既可能是 CJS `{ AudioIO, ... }`,也可能经 esm interop 落在 `.default`。
 */
function pickAudioIoFactory(mod: unknown): NativeAudioIoFactory | null {
  const candidates: unknown[] = [];
  if (mod && typeof mod === 'object') {
    const m = mod as Record<string, unknown>;
    candidates.push(m['AudioIO']);
    const d = m['default'];
    if (d && typeof d === 'object') candidates.push((d as Record<string, unknown>)['AudioIO']);
    candidates.push(d);
  }
  if (typeof mod === 'function') candidates.push(mod);
  for (const c of candidates) {
    if (typeof c === 'function') return c as NativeAudioIoFactory;
  }
  return null;
}
