/**
 * 真 Smart-Turn v3 EOU 接入(§4「说完没」/ §5b 行 100 Smart-Turn v3:吃音频判韵律,非转写)。
 *
 * `SmartTurnEouModel` 实现既有 {@link EouModel} 接缝:把累积用户音频窗截到最近 `maxWindowMs`,
 * 经**注入的同步端口** {@link EouInferenceSession} 推理得「已说完」概率,原样交既有 `DynamicEndpointing`
 * 定夺(TEN 3 态 / per-language / EMA 自校准全复用,本类**不做任何阈值判断**)——零改 VoiceLoop。
 *
 * 为何同步端口:`EouModel.predict` 被 VoiceLoop 在 `#shouldEndpoint` 同步调用且立即用结果
 * (packages/runtime/src/voice-loop.ts),故推理必须同步。真 Smart-Turn v3 经 **sherpa-onnx 同步原生绑定**
 * (呼应 canonical §9 行 324)实现 {@link EouInferenceSession} 注入。
 *
 * 隔离纪律(同 whisper-local / kokoro):端口最小面、**不暴露 onnxruntime/sherpa 类型**,
 * worktree/CI 不引原生依赖,测试注入 {@link FakeEouInferenceSession}。
 */
import type { PcmFrame } from '@chat-a/protocol';
import {
  DEFAULT_EOU_INFERENCE,
  type EouInferenceConfig,
} from './config';
import type { EouModel } from './turn-detector';

/**
 * EOU 同步推理端口:一段用户音频窗(Float32,[-1,1]) → 「已说完」概率(0~1)。
 *
 * **不暴露任何 onnxruntime/sherpa-onnx 类型**(最小面);运行时实现自行包同步原生绑定,
 * 内部做模型所需的特征/推理,`reset()` 在回合切换时清状态。
 */
export interface EouInferenceSession {
  /** 对一段音频窗同步推理,返回「已说完」概率(0~1)。 */
  infer(samples: Float32Array): number;
  /** 复位内部状态;回合切换调用。 */
  reset(): void;
}

/**
 * 确定性 EOU 推理端口桩(测试用):按**注入概率序列**同步产出(用完恒返回末值,无序列则 0)。
 * 记 `inferCount` 供断言;可选 `throwAt` 在第 N 次 infer 抛错以验降级。
 */
export class FakeEouInferenceSession implements EouInferenceSession {
  /** 已调用 infer 的次数。 */
  inferCount = 0;
  /** reset 调用次数。 */
  resetCount = 0;
  /** 最近一次 infer 收到的窗长(样本数),供断言截窗逻辑。 */
  lastWindowLen = 0;
  private idx = 0;
  private readonly probs: readonly number[];
  private readonly throwAt: number | undefined;

  constructor(probs: readonly number[] = [], opts?: { readonly throwAt?: number }) {
    this.probs = probs;
    this.throwAt = opts?.throwAt;
  }

  infer(samples: Float32Array): number {
    this.inferCount += 1;
    this.lastWindowLen = samples.length;
    if (this.throwAt !== undefined && this.inferCount === this.throwAt) {
      throw new Error('FakeEouInferenceSession: 注入的推理失败');
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

export interface SmartTurnEouModelOptions {
  /** 注入的同步推理端口(真 sherpa-onnx 绑定 / 测试 Fake)。 */
  readonly session: EouInferenceSession;
  /** 音频窗/采样率/归一化配置;缺省 {@link DEFAULT_EOU_INFERENCE}。 */
  readonly inference?: EouInferenceConfig;
}

/**
 * 真 Smart-Turn v3 EOU 模型:拼音频窗 + 截最近 maxWindowMs + 注入端口推理。实现 {@link EouModel}。
 * 概率原样返回交 `DynamicEndpointing`,本类不做阈值判断。
 */
export class SmartTurnEouModel implements EouModel {
  readonly #session: EouInferenceSession;
  readonly #maxSamples: number;
  readonly #normalize: boolean;

  constructor(opts: SmartTurnEouModelOptions) {
    if (opts.session === undefined || typeof opts.session.infer !== 'function') {
      // 缺端口 fail-fast(沿用「明确报错而非静默吞配置」):由运行时注入真 session。
      throw new Error('SmartTurnEouModel 需运行时提供 session 端口(EouInferenceSession)');
    }
    const inf = opts.inference ?? DEFAULT_EOU_INFERENCE;
    this.#session = opts.session;
    // 最近窗上限(样本数)= maxWindowMs × sampleRate / 1000。
    this.#maxSamples = Math.max(1, Math.floor((inf.maxWindowMs * inf.sampleRate) / 1000));
    this.#normalize = inf.normalize;
  }

  predict(window: readonly PcmFrame[]): number {
    if (window.length === 0) return 0; // 空窗:未说完,不推理

    // 拼 Int16 帧 → Float32([-1,1]),只保留最近 maxSamples 个样本(贴定长窗 + 防无界增长)。
    const samples = this.#toRecentFloat32(window);
    if (samples.length === 0) return 0;

    try {
      return this.#session.infer(samples);
    } catch {
      // 优雅降级:推理抛错视作「未说完」(概率 0),不向上抛。
      return 0;
    }
  }

  /** 取窗最近 maxSamples 样本,Int16→Float32,可选峰值归一化。 */
  #toRecentFloat32(window: readonly PcmFrame[]): Float32Array {
    // 从尾部往前收集到 maxSamples 即止(避免拼全窗再切的浪费)。
    const tail: number[] = [];
    for (let fi = window.length - 1; fi >= 0 && tail.length < this.#maxSamples; fi--) {
      const s = window[fi]!.samples;
      for (let i = s.length - 1; i >= 0 && tail.length < this.#maxSamples; i--) {
        const v = s[i]!;
        tail.push(v < 0 ? v / 32768 : v / 32767);
      }
    }
    tail.reverse(); // 收集时是倒序,翻回时间正序
    const out = Float32Array.from(tail);
    return this.#normalize ? normalizePeak(out) : out;
  }

  reset(): void {
    this.#session.reset();
  }
}

/** 峰值归一化:按窗内最大绝对值缩放到 [-1,1](弱化音量差异);全静音原样返回。 */
function normalizePeak(samples: Float32Array): Float32Array {
  let peak = 0;
  for (const v of samples) {
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }
  if (peak === 0) return samples;
  const out = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i]! / peak;
  return out;
}
