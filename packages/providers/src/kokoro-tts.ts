import type { PcmChunk } from './audio';
import { TTS_SAMPLE_RATE_HZ, pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';
import type { Device, ComputeType } from './hardware';

/**
 * Kokoro 本地轻量 TTS 的**注入式**适配(R1 隔离切片)。
 *
 * 为什么注入而非直接载 ONNX:worktree 里**不装 onnxruntime / 模型、不测真硬件**(任务硬约束)。
 * 引擎经**注入的 {@link KokoroSession} 端口**调用:端口吃 (text, voice, speed) → 吐 24kHz Float32 PCM;
 * 适配把 Float32 → Int16,切成 {@link PcmChunk} **流式 yield**(承 §4 流式优先,中途可干净打断)。
 * 运行时由调用方注入真 session(包一层 onnxruntime-node / kokoro-js);测试注入假 session。
 *
 * 复刻:Kokoro 为**预置音色**引擎,不支持 zero-shot 复刻,故 `voiceCloning=false`;
 * 请求带 refAudio 会被 assertTtsCloning fail-fast(§4.3/v2.1)。
 *
 * 缺端口时构造即 fail-fast(明确"需运行时提供 session",不静默)。
 */

/**
 * Kokoro 推理 session 端口(最小面):合成一段音频。
 *
 * **不暴露 onnxruntime 类型**(worktree 不引原生依赖):运行时实现自行包 ONNX session / kokoro-js,
 * 内部完成 g2p/分词/推理,只对外暴露 (text, voice, speed) → Float32 PCM @24k。
 * 返回 `Promise<Float32Array>`(整段)或 `AsyncIterable<Float32Array>`(分块流式)二选一;
 * 适配两种都吃(分块时逐块转 PcmChunk 流式 yield,整段时一次产出)。
 */
export interface KokoroSession {
  /**
   * 合成一段音频。
   * @param text 待合成文本(单段;由适配整体传入)。
   * @param voice 音色 id(如 'af_bella');由 opts.voiceId 覆盖默认。
   * @param speed 语速(1.0 常速)。
   * @param signal 中断信号(上层打断时停止推理)。
   * @returns 24kHz mono Float32 PCM(整段)或其分块流。
   */
  synthesize(
    text: string,
    voice: string,
    speed: number,
    signal?: AbortSignal,
  ): Promise<Float32Array> | AsyncIterable<Float32Array>;
}

export interface KokoroTtsOptions {
  /** provider 标识(如 'kokoro')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** 默认音色(可被 opts.voiceId 覆盖,如 'af_bella')。 */
  readonly voice: string;
  /** 注入的推理 session;缺省构造即抛"需运行时提供 session"。 */
  readonly session: KokoroSession;
  /** 默认语速(0.5-2.0,1.0 常速)。 */
  readonly speed?: number;
  /** 输出采样率(默认 24000)。 */
  readonly sampleRate?: number;
  /** 设备(本地引擎据此选 CPU/GPU;共享 {@link Device})。 */
  readonly device?: Device;
  /** 计算精度 / 量化档(共享 {@link ComputeType})。 */
  readonly computeType?: ComputeType;
  /** 是否要求 CUDA(能力位,§4.3 能力门;缺省视为不要求)。 */
  readonly requiresCuda?: boolean;
  /** 声明支持语种(能力位);默认 ['*']。 */
  readonly languages?: readonly string[];
}

export class KokoroTts implements TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  readonly #voice: string;
  readonly #session: KokoroSession;
  readonly #speed: number;
  readonly #sampleRate: number;

  constructor(opts: KokoroTtsOptions) {
    if (opts.session === undefined || typeof opts.session.synthesize !== 'function') {
      // 缺端口 fail-fast(沿用"明确报错而非静默吞配置"):由运行时注入真 session。
      throw new Error(
        `kokoro TTS 需运行时提供 session 端口(KokoroSession);config 已就位:voice=${opts.voice}`,
      );
    }
    this.id = opts.id;
    this.#voice = opts.voice;
    this.#session = opts.session;
    this.#speed = opts.speed ?? 1.0;
    this.#sampleRate = opts.sampleRate ?? TTS_SAMPLE_RATE_HZ;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      voiceId: [opts.voice],
      sampleRate: this.#sampleRate,
      streaming: true, // 分块流式 yield(中途可干净打断)。
      voiceCloning: false, // 预置音色引擎,不支持 zero-shot 复刻。
      ...(opts.requiresCuda !== undefined ? { requiresCuda: opts.requiresCuda } : {}),
    };
  }

  async *synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种 + 复刻能力(带 refAudio 即拦)。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    const voice = opts?.voiceId ?? this.#voice;
    const speed = opts?.speed ?? this.#speed;

    const out = this.#session.synthesize(text, voice, speed, signal);

    if (isAsyncIterable(out)) {
      // 分块流式:逐块 Float32 → Int16 PcmChunk(空块跳过)。
      for await (const f32 of out) {
        if (f32.length === 0) continue;
        yield pcmChunk(float32ToInt16(f32), this.#sampleRate);
      }
      return;
    }

    // 整段:一次推理 → 一个 PcmChunk(空音频不产块)。
    const f32 = await out;
    if (f32.length > 0) {
      yield pcmChunk(float32ToInt16(f32), this.#sampleRate);
    }
  }
}

/** Float32 PCM([-1,1]) → Int16 s16le(钳位防溢出;Kokoro 输出标准转码)。 */
function float32ToInt16(f32: Float32Array): Int16Array {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const v = f32[i] ?? 0;
    const clamped = v < -1 ? -1 : v > 1 ? 1 : v;
    // 负向乘 32768、正向乘 32767(对称钳位,避免 +1.0 溢出 Int16)。
    out[i] = clamped < 0 ? Math.round(clamped * 32768) : Math.round(clamped * 32767);
  }
  return out;
}

/** 运行时鸭子类型判别:是否 AsyncIterable(有 Symbol.asyncIterator)。 */
function isAsyncIterable<T>(x: Promise<T> | AsyncIterable<T>): x is AsyncIterable<T> {
  return typeof (x as AsyncIterable<T>)[Symbol.asyncIterator] === 'function';
}
