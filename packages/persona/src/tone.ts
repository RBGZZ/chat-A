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

/**
 * 渲染本轮 tone fragment(确定性,§6.1 tone 注入):PAD→离散情绪 + 旋钮(温暖/外显)。
 * 保持简短(控 token),拼在静态骨架之后。
 */
export function renderToneFragment(pad: Pad, dials: PersonaDials): string {
  const emotion = padToEmotion(pad);
  const lines = [`【当前情绪】${MOOD_TEXT[emotion]}`];
  if (dials.baselineWarmth >= 0.66) lines.push('整体保持温暖亲近的基调。');
  else if (dials.baselineWarmth <= 0.34) lines.push('整体基调偏冷淡克制。');
  if (dials.expressiveness >= 0.66) lines.push('情绪可以外放、表达明显。');
  else if (dials.expressiveness <= 0.34) lines.push('情绪表达含蓄、点到为止。');
  // 负面人际姿态(§7#6):激活时追加【姿态】行为指令(由 negativeAffectExpression 门控)。
  const postureLine = renderPostureLine(resolveNegativePosture(pad, dials), dials);
  if (postureLine !== null) lines.push(`【姿态】${postureLine}`);
  return lines.join('\n');
}
