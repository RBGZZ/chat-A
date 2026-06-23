import type { Ocean, OceanDelta, OceanDeltaSnapshot } from './types';
import { clamp01 } from './defaults';

/** OCEAN 五维键(单一权威列表,供逐维遍历)。 */
const OCEAN_KEYS = ['openness', 'conscientiousness', 'extraversion', 'agreeableness', 'neuroticism'] as const;

/** 把单维原始值钳到 [-max, +max];非有限值视作 0(不演化该维)。纯函数。 */
function clampDim(raw: number, max: number): number {
  if (!Number.isFinite(raw)) return 0;
  const m = Math.abs(max);
  return raw < -m ? -m : raw > m ? m : raw;
}

/**
 * 把任意来源的 OCEAN delta 逐维钳到 [-max, +max](§6.1 单次上限,默认 ±0.01)。
 * 非有限维度归零。纯函数、可写 golden:即使信号源返回 ±1 也不突破上限。
 */
export function clampOceanDelta(raw: OceanDelta, max: number): OceanDelta {
  return {
    openness: clampDim(raw.openness, max),
    conscientiousness: clampDim(raw.conscientiousness, max),
    extraversion: clampDim(raw.extraversion, max),
    agreeableness: clampDim(raw.agreeableness, max),
    neuroticism: clampDim(raw.neuroticism, max),
  };
}

/** 逐维把 delta 加到 OCEAN 上并钳回 [0,1]。纯函数。 */
export function applyOceanDelta(ocean: Ocean, delta: OceanDelta): Ocean {
  return {
    openness: clamp01(ocean.openness + delta.openness),
    conscientiousness: clamp01(ocean.conscientiousness + delta.conscientiousness),
    extraversion: clamp01(ocean.extraversion + delta.extraversion),
    agreeableness: clamp01(ocean.agreeableness + delta.agreeableness),
    neuroticism: clamp01(ocean.neuroticism + delta.neuroticism),
  };
}

/** delta 是否全零(全零 = 无需演化,跳过写快照)。纯函数。 */
export function isZeroDelta(delta: OceanDelta): boolean {
  return OCEAN_KEYS.every((k) => delta[k] === 0);
}

/**
 * 演化触发节拍判定(§6.1 每 N 轮):turn>0 且为 everyTurns 整数倍。纯函数、可写 golden。
 * everyTurns ≤ 0 视作"永不触发"(防 magic/除零)。
 */
export function shouldEvolve(turn: number, everyTurns: number): boolean {
  if (everyTurns <= 0) return false;
  return turn > 0 && turn % everyTurns === 0;
}

/** 构造一条版本快照(§6.1 history,可回溯/可回滚)。纯函数。 */
export function buildDeltaSnapshot(
  before: Ocean,
  after: Ocean,
  delta: OceanDelta,
  turn: number,
  at: string,
): OceanDeltaSnapshot {
  return { turn, at, before, after, delta };
}
