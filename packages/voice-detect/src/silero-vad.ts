/**
 * 真 Silero VAD 接入(§4「有没有声」/ §5b 行 105 Silero 16k/512)。
 *
 * `SileroVadDetector` 实现既有 {@link VadDetector} 接缝:把协议帧(160 样本/10ms)缓冲成 Silero 习惯的
 * 推理窗(默认 512 样本/32ms),每攒满一窗经**注入的同步端口** {@link VadInferenceSession} 推一次得语音概率,
 * 复用既有 {@link VadGate}(同一套「概率 → 去抖 → speech_start/end」状态机)产出事件——**零改 VoiceLoop**。
 *
 * 为何同步端口:VoiceLoop 在 `#onAudio` 同步调用 `pushFrame` 并立即读 `result.event`/`result.speaking`
 * (packages/runtime/src/voice-loop.ts),故推理必须同步。真 Silero 经 **sherpa-onnx 同步原生绑定**
 * (其 Node VAD 推理为同步阻塞,契合本接缝;呼应 canonical §9 行 324 Sherpa-ONNX 方向)实现 {@link VadInferenceSession} 注入。
 *
 * 隔离纪律(同 whisper-local `SpawnFn` / kokoro `KokoroSession`):端口最小面、**不暴露 onnxruntime/sherpa 类型**,
 * worktree/CI 不引原生依赖,测试注入 {@link FakeVadInferenceSession}。
 */
import type { PcmFrame } from '@chat-a/protocol';
import {
  DEFAULT_VAD_CONFIG,
  DEFAULT_VAD_INFERENCE,
  type VadConfig,
  type VadInferenceConfig,
} from './config';
import { VadGate, type VadDetector, type VadFrameResult } from './vad';

/**
 * VAD 同步推理端口:一窗 16k mono PCM(Float32,[-1,1]) → 该窗语音概率(0~1)。
 *
 * **不暴露任何 onnxruntime/sherpa-onnx 类型**(最小面);运行时实现自行包同步原生绑定,
 * 内部维护 Silero RNN 隐状态,`reset()` 在回合切换时清隐状态。
 */
export interface VadInferenceSession {
  /** 对一窗音频同步推理,返回语音概率(0~1)。 */
  infer(samples: Float32Array): number;
  /** 复位内部状态(如 Silero RNN 隐状态);回合切换调用。 */
  reset(): void;
}

/**
 * 确定性 VAD 推理端口桩(测试用):按**注入概率序列**同步产出概率(用完恒返回末值,无序列则 0)。
 * 记 `inferCount` 供断言「攒满一窗才推理一次」。可选 `throwAt` 在第 N 次 infer 抛错以验降级。
 */
export class FakeVadInferenceSession implements VadInferenceSession {
  /** 已调用 infer 的次数(断言推理时机用)。 */
  inferCount = 0;
  /** reset 调用次数。 */
  resetCount = 0;
  private idx = 0;
  private readonly probs: readonly number[];
  private readonly throwAt: number | undefined;

  constructor(probs: readonly number[] = [], opts?: { readonly throwAt?: number }) {
    this.probs = probs;
    this.throwAt = opts?.throwAt;
  }

  infer(_samples: Float32Array): number {
    this.inferCount += 1;
    if (this.throwAt !== undefined && this.inferCount === this.throwAt) {
      throw new Error('FakeVadInferenceSession: 注入的推理失败');
    }
    const last = this.probs.length > 0 ? this.probs[this.probs.length - 1]! : 0;
    const p = this.probs[this.idx] ?? last;
    if (this.idx < this.probs.length) this.idx += 1;
    return p;
  }

  reset(): void {
    this.resetCount += 1;
    this.idx = 0;
  }
}

export interface SileroVadDetectorOptions {
  /** 注入的同步推理端口(真 sherpa-onnx 绑定 / 测试 Fake)。 */
  readonly session: VadInferenceSession;
  /** 去抖配置(复用既有 VadGate 配置);缺省 {@link DEFAULT_VAD_CONFIG}。 */
  readonly vadConfig?: VadConfig;
  /** 推理窗/采样率配置;缺省 {@link DEFAULT_VAD_INFERENCE}。 */
  readonly inference?: VadInferenceConfig;
}

/**
 * 真 Silero VAD 检测器:帧→窗缓冲 + 注入端口推理 + 复用 VadGate 去抖。实现 {@link VadDetector}。
 */
export class SileroVadDetector implements VadDetector {
  readonly #session: VadInferenceSession;
  readonly #gate: VadGate;
  readonly #windowSamples: number;
  /** 跨帧累积的样本缓冲(Float32,[-1,1]);满 windowSamples 即推理并消费整窗。 */
  #buf: number[] = [];
  /** 最近一次推理得到的概率;未攒满新窗时复用(不重复推理、不阻塞)。 */
  #lastProb = 0;

  constructor(opts: SileroVadDetectorOptions) {
    if (opts.session === undefined || typeof opts.session.infer !== 'function') {
      // 缺端口 fail-fast(沿用「明确报错而非静默吞配置」):由运行时注入真 session。
      throw new Error('SileroVadDetector 需运行时提供 session 端口(VadInferenceSession)');
    }
    this.#session = opts.session;
    this.#gate = new VadGate(opts.vadConfig ?? DEFAULT_VAD_CONFIG);
    this.#windowSamples = (opts.inference ?? DEFAULT_VAD_INFERENCE).windowSamples;
  }

  pushFrame(frame: PcmFrame): VadFrameResult {
    // Int16 帧样本 → Float32([-1,1]) 累积(对称解码:负向 /32768、正向 /32767)。
    for (const s of frame.samples) {
      this.#buf.push(s < 0 ? s / 32768 : s / 32767);
    }
    // 攒满一窗即推理一次(一帧可能攒不满,也可能跨多窗,循环排空整窗)。
    while (this.#buf.length >= this.#windowSamples) {
      const window = Float32Array.from(this.#buf.slice(0, this.#windowSamples));
      this.#buf = this.#buf.slice(this.#windowSamples);
      this.#lastProb = this.#inferSafe(window);
    }
    // 用最近一窗概率跑去抖(未满新窗时复用上一概率)。
    return this.#gate.step(this.#lastProb, frame.timestampMs);
  }

  /** 同步推理 + 优雅降级:端口抛错 → 该窗视作静音(概率 0,不误触发 speech_start)。 */
  #inferSafe(window: Float32Array): number {
    try {
      return this.#session.infer(window);
    } catch {
      return 0;
    }
  }

  reset(): void {
    this.#buf = [];
    this.#lastProb = 0;
    this.#gate.reset();
    this.#session.reset();
  }
}
