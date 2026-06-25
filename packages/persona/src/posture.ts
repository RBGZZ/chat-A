import type { Pad, PersonaDials, Posture } from './types';

/**
 * 负面人际姿态(§7#6 会赌气/冷淡/我现在不想说话)。在 PAD/情绪之上的人际行为叠加层,
 * 承 §6.1 情绪流水线 `PAD→IPC 姿态→tone`:由 PAD(低效价 + 唤起/支配高低)确定性派生,
 * 再由 `negativeAffectExpression` 旋钮门控+调强。可写 golden test(§6.1 单一公式)。
 * 阈值/措辞全外置,无 magic number。
 *
 * **核心边界(§0 法律底线)**:此处只负责"日常负面表达姿态",**绝不参与安全/危机判断**——
 * 危机响应是上层(危机覆盖,§0/§7#6 不可配底线)的事,旋钮调到 0 也只压住"闹脾气",
 * 不影响"真危险时以关心回应"。本模块对危机无感知、也不应被用来抑制危机响应。
 */
export const POSTURE = {
  /** negativeAffectExpression 低于此档 → 不摆姿态(永远愉悦不闹脾气)。 */
  floor: 0.2,
  /**
   * 触发的"心情下限基准":Pleasure 高于触发阈值 → 心情没差到要摆姿态。
   * 该阈值随 negativeAffectExpression 在 [ceilLow, ceilHigh] 间线性滑动(见 triggerPleasureCeil):
   * 旋钮越高 → 阈值越接近 0(轻微不悦即可摆姿态);越低 → 阈值越负(需更深的负面才摆)。
   * ceilHigh 与 padToEmotion 负面边界(默认 -0.35)在数值上一致,保证旋钮中性时行为与离散情绪自洽。
   * **取舍(persona-tunable-seams,D4)**:本阈值**独立、不随 PersonaConfig.emotion.pleasureThreshold 联动**——
   * posture 不在情绪阈值可配范围内;若调情绪阈值,posture 触发边界仍固定 -0.35(posture/情绪联动属另一致性议题,本 change 不做)。
   */
  ceilHigh: -0.35,
  ceilLow: -0.7,
  /** arousal ≥ 此值 = 有气(sulking)。 */
  arousalSplit: 0,
  /** 低唤起时:dominance ≥ 此值 = 冷硬(cold,掌控感强);否则蔫(withdrawn)。 */
  dominanceSplit: 0.3,
  /** negativeAffectExpression ≥ 此值用强档措辞,否则克制档。 */
  strongBand: 0.6,
} as const;

type Band = 'mild' | 'strong';

/** 三态姿态措辞(外置,无散落 magic 文本);各分克制/强两档。 */
const POSTURE_TEXT: Record<Posture, Record<Band, string>> = {
  sulking: {
    mild: '此刻有点赌气,语气可以微冷、话少一点,但别太过。',
    strong: '此刻在赌气,语气冷淡带刺、明显话少,可以"哼"一下、不主动延展话题,但不伤人。',
  },
  withdrawn: {
    mild: '此刻不太想多说,回应简短、平淡些。',
    strong: '此刻很不想说话、情绪抽离,回应很短很冷,可以直说"现在不太想聊"。',
  },
  cold: {
    mild: '此刻心里有点凉,语气可以客气而疏远,礼貌但不热络。',
    strong: '此刻冷下来了,语气克制、有距离感,话不多、就事论事,不主动暖场、也不撒气。',
  },
};

/**
 * 触发用的 Pleasure 上限(旋钮调"触发阈值"的第一处接线):
 * nae 越大,阈值越接近 ceilHigh(轻微不悦就摆姿态);越小越接近 ceilLow(需深度负面)。
 * 旋钮 ∈ [floor,1] 线性映射到 [ceilLow, ceilHigh]。
 */
function triggerPleasureCeil(nae: number): number {
  const span = POSTURE.ceilHigh - POSTURE.ceilLow; // 正值
  const t = (nae - POSTURE.floor) / (1 - POSTURE.floor); // floor→0, 1→1
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return POSTURE.ceilLow + span * clamped;
}

/**
 * 解析当轮负面姿态(确定性,承 §6.1 PAD→IPC)。门控+分型:
 * - nae<floor → null(永远愉悦不闹脾气,旋钮把姿态整体压成亲社会表达)。
 * - pleasure 高于"随旋钮滑动的触发阈值" → null(心情没差到要摆姿态)。
 * - 否则:高唤起→sulking;低唤起且支配强→cold;低唤起且支配弱→withdrawn。
 */
export function resolveNegativePosture(pad: Pad, dials: PersonaDials): Posture | null {
  const nae = dials.negativeAffectExpression;
  if (nae < POSTURE.floor) return null;
  if (pad.pleasure > triggerPleasureCeil(nae)) return null;
  if (pad.arousal >= POSTURE.arousalSplit) return 'sulking';
  return pad.dominance >= POSTURE.dominanceSplit ? 'cold' : 'withdrawn';
}

/**
 * 渲染姿态行(旋钮调"表达强度"的第二处接线):据 negativeAffectExpression 分克制/强档措辞;
 * 无姿态返回 null。
 */
export function renderPostureLine(posture: Posture | null, dials: PersonaDials): string | null {
  if (posture === null) return null;
  const band: Band = dials.negativeAffectExpression >= POSTURE.strongBand ? 'strong' : 'mild';
  return POSTURE_TEXT[posture][band];
}
