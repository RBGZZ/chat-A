import type { PersonaConfig, PersonaDials } from './types';

/** 旋钮默认值:多数 0.5 中性,基础温暖略偏暖 0.6(§6.1)。 */
export const DEFAULT_DIALS: PersonaDials = {
  assertiveness: 0.5,
  negativeAffectExpression: 0.5,
  proactivity: 0.5,
  intimacyPace: 0.5,
  emotionalIntensity: 0.5,
  emotionalVolatility: 0.5,
  baselineWarmth: 0.6,
  expressiveness: 0.5,
};

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  coldStartTurns: 5,
  coldStartReboundFactor: 2,
  evolutionEveryTurns: 20,
  maxOceanDeltaPerStep: 0.01,
};

/**
 * self_notions 强度演化与持久化的外置常量(§7#3,行为即配置、无 magic number)。
 */
/** 立场基线强度:缺省(未标注 strength)立场视作此强度——中性偏稳,保证命中行为等价当前。 */
export const SELF_NOTION_BASE_STRENGTH = 0.5;
/** 单次强度增量上限(保守、只增不减;承 §6.1 单步上限纪律)。 */
export const MAX_STRENGTH_DELTA_PER_STEP = 0.05;
/**
 * stance 压制门槛:**显式标注**强度低于此值的立场,在低 assertiveness 下更趋沉默。
 * 缺省强度(SELF_NOTION_BASE_STRENGTH=0.5)高于此门槛,故旧种子命中行为不变。
 */
export const SELF_NOTION_STRENGTH_FLOOR = 0.3;
/** self_notions 持久化 schema 版本(§6.1 迁移纪律)。 */
export const SELF_NOTIONS_SCHEMA_VERSION = 1;

/** 钳制到 [-1,1]。 */
export function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/** 钳制到 [0,1](OCEAN 维度的合法区间)。 */
export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** [0,1] 居中到 [-1,1](OCEAN→PAD 前的归一)。 */
export function centered(v01: number): number {
  return v01 * 2 - 1;
}
