import type { Pad, PersonaDials, Posture } from './types';

/**
 * 负面人际姿态(§7#6 会赌气/冷淡)。在 PAD/情绪之上的人际行为叠加层,
 * 由 `negativeAffectExpression` 旋钮门控、确定性派生(可写 golden test,§6.1 单一公式)。
 * 阈值/措辞全外置,无 magic number。
 */
export const POSTURE = {
  /** negativeAffectExpression 低于此档 → 不摆姿态(永远愉悦不闹脾气)。 */
  floor: 0.2,
  /** Pleasure 高于此值 → 心情没差到要摆姿态(与 padToEmotion 负面边界一致)。 */
  pleasureCeil: -0.35,
  /** arousal ≥ 此值 = 有气(sulking),否则蔫(withdrawn)。 */
  arousalSplit: 0,
  /** negativeAffectExpression ≥ 此值用强档措辞,否则克制档。 */
  strongBand: 0.6,
} as const;

type Band = 'mild' | 'strong';

/** 四条姿态措辞(外置,无散落 magic 文本)。 */
const POSTURE_TEXT: Record<Posture, Record<Band, string>> = {
  sulking: {
    mild: '此刻有点赌气,语气可以微冷、话少一点,但别太过。',
    strong: '此刻在赌气,语气冷淡带刺、明显话少,可以"哼"一下、不主动延展话题,但不伤人。',
  },
  withdrawn: {
    mild: '此刻不太想多说,回应简短、平淡些。',
    strong: '此刻很不想说话、情绪抽离,回应很短很冷,可以直说"现在不太想聊"。',
  },
};

/**
 * 解析当轮负面姿态(确定性)。门控:nae<floor → null(压住);pleasure>ceil → null(心情没差到);
 * 否则按 arousal 高低分 sulking/withdrawn。
 */
export function resolveNegativePosture(pad: Pad, dials: PersonaDials): Posture | null {
  if (dials.negativeAffectExpression < POSTURE.floor) return null;
  if (pad.pleasure > POSTURE.pleasureCeil) return null;
  return pad.arousal >= POSTURE.arousalSplit ? 'sulking' : 'withdrawn';
}

/** 渲染姿态行(据 negativeAffectExpression 分档);无姿态返回 null。 */
export function renderPostureLine(posture: Posture | null, dials: PersonaDials): string | null {
  if (posture === null) return null;
  const band: Band = dials.negativeAffectExpression >= POSTURE.strongBand ? 'strong' : 'mild';
  return POSTURE_TEXT[posture][band];
}
