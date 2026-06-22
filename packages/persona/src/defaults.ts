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
};

/** 钳制到 [-1,1]。 */
export function clampUnit(x: number): number {
  return x < -1 ? -1 : x > 1 ? 1 : x;
}

/** [0,1] 居中到 [-1,1](OCEAN→PAD 前的归一)。 */
export function centered(v01: number): number {
  return v01 * 2 - 1;
}
