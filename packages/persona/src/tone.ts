import type { Emotion, Pad, PersonaDials } from './types';
import { padToEmotion } from './numeric';
import { resolveNegativePosture, renderPostureLine } from './posture';

const MOOD_TEXT: Record<Emotion, string> = {
  joyful: '此刻心情很好、有点兴奋,语气可以轻快、带点雀跃。',
  content: '此刻心情平和愉悦,语气放松、温和。',
  neutral: '此刻心情平平,语气自然就好,不必刻意热络。',
  down: '此刻心情低落,语气低沉、话少一些,别强装开朗。',
  irritated: '此刻有点烦躁,语气可以稍冲、没那么耐心,但别失礼。',
};

/** 关系亲密度三档:'far' 疏远 / 'mid' 适中 / 'near' 亲近(§2.4 closeness→tone)。 */
type CloseBand = 'far' | 'mid' | 'near';

/**
 * 关系亲密度(closeness)分档阈值 + 三档文案(外置,沿 POSTURE 风格,无散落 magic number)。
 * 阈值随 dials 风格可配;closeness ∈ [0,1] 落档:<midLow 疏远 / [midLow,midHigh] 适中 / >midHigh 亲近。
 */
export const CLOSENESS = {
  /** 低于此值 = 疏远档。 */
  midLow: 0.34,
  /** 高于此值 = 亲近档。 */
  midHigh: 0.66,
} as const;

/**
 * 关系亲密度三档语气指令(单向 → 表达,§2.4):
 * - near 高亲密:更暖、更愿分享自己的事、用更亲昵的称呼。
 * - mid 适中:关系平稳,不刻意拉近也不疏远。
 * - far 低亲密:礼貌克制、少自我披露,保持适当距离。
 * 适中档不追加(关系语气不显著,省 token);仅疏远/亲近追加一行。
 */
const CLOSENESS_TEXT: Record<CloseBand, string | null> = {
  near: '【关系】关系亲近:语气更暖、更愿意主动分享自己的事和感受,可以用更亲昵的称呼。',
  mid: null,
  far: '【关系】关系还较疏远:语气礼貌而克制,少做自我披露,保持适当距离、不过分热络。',
};

/** closeness 值落档(确定性,承 CLOSENESS 阈值)。 */
function closenessBand(closeness: number): CloseBand {
  if (closeness > CLOSENESS.midHigh) return 'near';
  if (closeness < CLOSENESS.midLow) return 'far';
  return 'mid';
}

/**
 * 渲染本轮 tone fragment(确定性,§6.1 tone 注入):PAD→离散情绪 + 旋钮(温暖/外显)。
 * 保持简短(控 token),拼在静态骨架之后。
 *
 * `closeness`(§2.4 关系亲密度,中速慢变量,可选):
 * - **省略时逐字等于旧行为**(向后兼容,不追加任何关系行)。
 * - 提供时按 CLOSENESS 三档追加一行【关系】语气指令(高→更暖/愿分享、低→礼貌克制/少披露;
 *   适中档不追加)。closeness 单向影响表达,绝不反改 OCEAN/PAD。
 */
export function renderToneFragment(pad: Pad, dials: PersonaDials, closeness?: number): string {
  const emotion = padToEmotion(pad);
  const lines = [`【当前情绪】${MOOD_TEXT[emotion]}`];
  if (dials.baselineWarmth >= 0.66) lines.push('整体保持温暖亲近的基调。');
  else if (dials.baselineWarmth <= 0.34) lines.push('整体基调偏冷淡克制。');
  if (dials.expressiveness >= 0.66) lines.push('情绪可以外放、表达明显。');
  else if (dials.expressiveness <= 0.34) lines.push('情绪表达含蓄、点到为止。');
  // 负面人际姿态(§7#6):激活时追加【姿态】行为指令(由 negativeAffectExpression 门控)。
  const postureLine = renderPostureLine(resolveNegativePosture(pad, dials), dials);
  if (postureLine !== null) lines.push(`【姿态】${postureLine}`);
  // 关系亲密度(§2.4):仅在提供 closeness 时追加;省略则与旧行为逐字相等。
  if (closeness !== undefined) {
    const closeLine = CLOSENESS_TEXT[closenessBand(closeness)];
    if (closeLine !== null) lines.push(closeLine);
  }
  return lines.join('\n');
}
