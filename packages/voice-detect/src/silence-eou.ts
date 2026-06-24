/**
 * 无模型静音超时 EOU(承「填 key 即测」目标:detect 层零模型可用)。
 *
 * `SilenceTimeoutEouModel` 实现既有 {@link EouModel} 接缝,但**不依赖任何模型**:据用户音频窗**尾部**
 * 连续「低能量(静音)」样本累积时长判「已说完」概率——尾静音 ≥ `silenceTimeoutMs` → 高 eouProb(≈1),
 * 否则低(≈0)。概率交既有 `DynamicEndpointing` 策略层定夺(本类不做阈值判断,与之正交可组合)。
 *
 * 为何看「窗尾」:`EouModel.predict(window)` 只吃音频窗(不吃 silenceMs),故用「最近一段是否安静」
 * 近似「停下来了没」——无需模型即可对真音频停顿有反应。与 {@link SmartTurnEouModel} 同接口、可互换。
 */
import type { PcmFrame } from '@chat-a/protocol';
import { DEFAULT_SILENCE_EOU_CONFIG, type SilenceEouConfig } from './config';
import type { EouModel } from './turn-detector';

export interface SilenceTimeoutEouModelOptions {
  /** 静音超时/阈值配置;缺省 {@link DEFAULT_SILENCE_EOU_CONFIG}。 */
  readonly config?: SilenceEouConfig;
  /** 判「已说完」时返回的高概率(缺省 1)。 */
  readonly finishedProb?: number;
  /** 未达静音超时返回的低概率(缺省 0)。 */
  readonly ongoingProb?: number;
}

export class SilenceTimeoutEouModel implements EouModel {
  readonly #cfg: SilenceEouConfig;
  readonly #finished: number;
  readonly #ongoing: number;
  /** 达成判定所需的尾部连续静音样本数。 */
  readonly #thresholdSamples: number;

  constructor(opts: SilenceTimeoutEouModelOptions = {}) {
    this.#cfg = opts.config ?? DEFAULT_SILENCE_EOU_CONFIG;
    this.#finished = opts.finishedProb ?? 1;
    this.#ongoing = opts.ongoingProb ?? 0;
    this.#thresholdSamples = Math.max(
      1,
      Math.floor((this.#cfg.silenceTimeoutMs * this.#cfg.sampleRate) / 1000),
    );
  }

  predict(window: readonly PcmFrame[]): number {
    if (window.length === 0) return this.#ongoing; // 空窗:未说完。
    const threshold = this.#cfg.silenceRmsThreshold * this.#cfg.fullScale;
    let trailingSilence = 0;
    // 从窗尾向前数连续「低能量」样本,累计到阈值即可判定(早停,不扫全窗)。
    for (let fi = window.length - 1; fi >= 0; fi--) {
      const s = window[fi]!.samples;
      for (let i = s.length - 1; i >= 0; i--) {
        if (Math.abs(s[i]!) < threshold) {
          trailingSilence++;
          if (trailingSilence >= this.#thresholdSamples) return this.#finished;
        } else {
          return this.#ongoing; // 遇到有声样本即中断:窗尾不够安静 → 未说完。
        }
      }
    }
    // 整窗都安静但不足阈值时长 → 仍未说完(可能用户只是没说几个字)。
    return trailingSilence >= this.#thresholdSamples ? this.#finished : this.#ongoing;
  }

  reset(): void {
    // 无内部累积状态(每次 predict 独立看窗);留空以满足接口。
  }
}
