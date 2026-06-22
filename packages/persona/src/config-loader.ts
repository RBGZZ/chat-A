import type { PersonaDials, PersonaSeed } from './types';
import { XIAOXUE_SEED } from './seed';

/**
 * 从环境变量装配 PersonaSeed(行为即配置 / 用户自治,§6.2):
 *   CHAT_A_PERSONA_NAME / CHAT_A_PERSONA_IDENTITY  覆盖名字/身份背景文本
 *   CHAT_A_DIAL_WARMTH / _EXPRESSIVENESS / _VOLATILITY / _INTENSITY  情绪旋钮 [0,1]
 * 缺省回落到默认种子(等价原 XIAOXUE),保证既有行为不破。
 */
function num01(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

export function loadPersonaSeedFromEnv(env: NodeJS.ProcessEnv = process.env): PersonaSeed {
  const base = XIAOXUE_SEED;
  const dials: PersonaDials = {
    ...base.dials,
    baselineWarmth: num01(env['CHAT_A_DIAL_WARMTH'], base.dials.baselineWarmth),
    expressiveness: num01(env['CHAT_A_DIAL_EXPRESSIVENESS'], base.dials.expressiveness),
    emotionalVolatility: num01(env['CHAT_A_DIAL_VOLATILITY'], base.dials.emotionalVolatility),
    emotionalIntensity: num01(env['CHAT_A_DIAL_INTENSITY'], base.dials.emotionalIntensity),
  };
  const name = env['CHAT_A_PERSONA_NAME'];
  const identity = env['CHAT_A_PERSONA_IDENTITY'];
  return {
    ...base,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    ...(identity !== undefined && identity.length > 0 ? { identity } : {}),
    dials,
  };
}
