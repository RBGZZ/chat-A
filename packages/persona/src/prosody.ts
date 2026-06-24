import type { PadPull } from './types';
import { clampUnit } from './defaults';

/**
 * 从语音读情绪 prosody → PAD 拉力(确定性内核,§7#5「听出怎么说的」)。
 *
 * STT(如 qwen3-asr)在转写文本之外可读出说话人的 prosody 情绪标签(§7#5);本纯函数把该离散
 * 标签映射成 PAD `PadPull`,供 §6.1 `stepPad` 消费——与文本 appraiser 的「说了什么」并轨喂入 PAD。
 *
 * 设计要点(承 §3.2 行为即配置 / 可测试性 / 优雅降级):
 * - **纯函数**:同入参输出全等,可 golden test;无副作用、不触网。
 * - **映射表外置可配**({@link DEFAULT_PROSODY_PAD_MAP},无 magic number、可注入覆盖)。
 * - **不依赖 providers 包**:入参用结构类型 {@link SttEmotionLike}(providers 的 `SttEmotion` 结构上满足之),
 *   接缝边界(§3.1,同 KvLike 手法)。
 * - **安全降级**:emotion 缺省 / 标签不在表内 / neutral → **零拉力**(stepPad 仅按基线回归、不施加语音拉力)。
 */

/** 情绪信号的结构类型(不依赖 providers;`{ label, confidence? }` 即可)。 */
export interface SttEmotionLike {
  readonly label: string;
  /** 置信度 [0,1];若在 (0,1] 则线性缩放拉力,缺省/越界视作 1(不缩放)。 */
  readonly confidence?: number;
}

/**
 * 默认 prosody 情绪 → PAD 拉力映射表(行为即配置,可注入覆盖)。
 * 方向依 PAD 情绪心理学常识;量级保守(与文本 appraiser 的 unit≈0.4 同档,避免语音盖过文本)。
 * `neutral` 不入表 → 走零拉力降级(见 prosodyToPadPull)。
 */
export const DEFAULT_PROSODY_PAD_MAP: Readonly<Record<string, PadPull>> = {
  happy: { pleasure: 0.4, arousal: 0.3, dominance: 0.2 }, // 愉悦、上扬、有掌控
  surprised: { pleasure: 0.0, arousal: 0.5, dominance: -0.1 }, // 强唤起、略失控
  sad: { pleasure: -0.4, arousal: -0.3, dominance: -0.3 }, // 低落、蔫、无力
  fearful: { pleasure: -0.3, arousal: 0.4, dominance: -0.4 }, // 负向、紧张、被压
  angry: { pleasure: -0.3, arousal: 0.4, dominance: 0.3 }, // 负向、激动、有攻击性
  disgusted: { pleasure: -0.4, arousal: 0.1, dominance: 0.1 }, // 厌恶、负向
};

/** 零拉力(无语音情绪贡献)。 */
const ZERO_PULL: PadPull = { pleasure: 0, arousal: 0, dominance: 0 };

/**
 * prosody 情绪 → PAD 拉力。
 * - emotion 为 undefined / 标签不在 map 内 / neutral → 零拉力(安全降级)。
 * - confidence ∈ (0,1] → 拉力线性缩放;否则视作 1(不缩放)。
 * - 结果各维钳制 [-1,1]。
 */
export function prosodyToPadPull(
  emotion?: SttEmotionLike,
  map: Readonly<Record<string, PadPull>> = DEFAULT_PROSODY_PAD_MAP,
): PadPull {
  if (emotion === undefined) return ZERO_PULL;
  const base = map[emotion.label];
  if (base === undefined) return ZERO_PULL; // 未知/neutral(neutral 不入表)→ 零拉力。

  const c = emotion.confidence;
  const scale = typeof c === 'number' && c > 0 && c <= 1 ? c : 1;

  return {
    pleasure: clampUnit(base.pleasure * scale),
    arousal: clampUnit(base.arousal * scale),
    dominance: clampUnit(base.dominance * scale),
  };
}
