/**
 * 无模型能量阈值 VAD(承「填 key 即测」目标:detect 层零模型可用)。
 *
 * `EnergyVadDetector` 实现既有 {@link VadDetector} 接缝:逐帧算 RMS 能量 → 归一化到 0~1(除以 Int16 满量程)
 * → 当作「语音概率」喂**既有 {@link VadGate}**(复用同一套「概率 → 去抖 → speech_start/end」状态机)。
 * **无 ONNX、无模型文件、无原生依赖**——纯算术,任何环境可跑。
 *
 * 与 {@link SileroVadDetector} 对称(都实现同接口、都复用 VadGate),区别只在「概率从哪来」:
 * Silero 来自模型推理,这里来自帧能量。故换档 = 换实现,VoiceLoop 零改(§3.1/§4)。
 */
import type { PcmFrame } from '@chat-a/protocol';
import {
  DEFAULT_ENERGY_VAD_CONFIG,
  DEFAULT_VAD_CONFIG,
  type EnergyVadConfig,
  type VadConfig,
} from './config';
import { VadGate, type VadDetector, type VadFrameResult } from './vad';

export interface EnergyVadDetectorOptions {
  /** 去抖配置(复用既有 VadGate 配置);缺省 {@link DEFAULT_VAD_CONFIG}。 */
  readonly vadConfig?: VadConfig;
  /** 能量阈值/归一化配置;缺省 {@link DEFAULT_ENERGY_VAD_CONFIG}。 */
  readonly energy?: EnergyVadConfig;
}

export class EnergyVadDetector implements VadDetector {
  readonly #gate: VadGate;
  readonly #energy: EnergyVadConfig;

  constructor(opts: EnergyVadDetectorOptions = {}) {
    // 用能量阈值覆盖 VadGate 的 speechProbThreshold,使「归一化 RMS ≥ rmsThreshold」即视为有声。
    const energy = opts.energy ?? DEFAULT_ENERGY_VAD_CONFIG;
    const base = opts.vadConfig ?? DEFAULT_VAD_CONFIG;
    this.#energy = energy;
    this.#gate = new VadGate({ ...base, speechProbThreshold: energy.rmsThreshold });
  }

  pushFrame(frame: PcmFrame): VadFrameResult {
    const prob = normalizedRms(frame.samples, this.#energy.fullScale);
    return this.#gate.step(prob, frame.timestampMs);
  }

  reset(): void {
    this.#gate.reset();
  }
}

/** 计算一帧的归一化 RMS(0~1):sqrt(mean(sample^2)) / fullScale,夹到 [0,1]。 */
export function normalizedRms(samples: Int16Array, fullScale: number): number {
  if (samples.length === 0) return 0;
  let sumSq = 0;
  for (const s of samples) sumSq += s * s;
  const rms = Math.sqrt(sumSq / samples.length);
  const norm = rms / fullScale;
  return norm > 1 ? 1 : norm;
}
