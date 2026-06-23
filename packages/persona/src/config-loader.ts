import type { LoadedPersonaCard, PersonaDials, PersonaSeed } from './types';
import { loadPersonaCard } from './card-loader';

/**
 * 装配 PersonaSeed + 待种子化列表(§6.2 用户自治)。优先级:**默认种子 < 卡 < env**。
 *   CHAT_A_PERSONA_CARD      指定 YAML PersonaCard 路径(缺省=默认种子;详见 card-loader)
 *   CHAT_A_PERSONA_NAME / CHAT_A_PERSONA_IDENTITY  逐字段覆盖卡的名字/身份
 *   CHAT_A_DIAL_WARMTH / _EXPRESSIVENESS / _VOLATILITY / _INTENSITY  情绪旋钮 [0,1] 覆盖卡值
 *   CHAT_A_DIAL_NEGATIVE_AFFECT  负面表达旋钮 [0,1](§7#6:0=永远愉悦不闹脾气;1=完整表达坏心情/会赌气冷淡)
 * env 仅作覆盖层:卡缺省时 env 仍单独生效(向后兼容);卡存在时 env 逐字段盖卡。
 */
function num01(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * 加载 persona:先读卡(无卡=默认种子),再让 env 逐字段覆盖。
 * 返回种子 + 卡里的 lore/userProfile(env 不涉及这两个列表)。
 */
export function loadPersonaFromEnv(env: NodeJS.ProcessEnv = process.env): LoadedPersonaCard {
  const loaded = loadPersonaCard(env['CHAT_A_PERSONA_CARD']);
  const base = loaded.seed;
  const dials: PersonaDials = {
    ...base.dials,
    baselineWarmth: num01(env['CHAT_A_DIAL_WARMTH'], base.dials.baselineWarmth),
    expressiveness: num01(env['CHAT_A_DIAL_EXPRESSIVENESS'], base.dials.expressiveness),
    emotionalVolatility: num01(env['CHAT_A_DIAL_VOLATILITY'], base.dials.emotionalVolatility),
    emotionalIntensity: num01(env['CHAT_A_DIAL_INTENSITY'], base.dials.emotionalIntensity),
    negativeAffectExpression: num01(env['CHAT_A_DIAL_NEGATIVE_AFFECT'], base.dials.negativeAffectExpression),
  };
  const name = env['CHAT_A_PERSONA_NAME'];
  const identity = env['CHAT_A_PERSONA_IDENTITY'];
  const seed: PersonaSeed = {
    ...base,
    ...(name !== undefined && name.length > 0 ? { name } : {}),
    ...(identity !== undefined && identity.length > 0 ? { identity } : {}),
    dials,
  };
  return { ...loaded, seed };
}

/** 向后兼容:仅取种子(老调用方)。等价 `loadPersonaFromEnv().seed`。 */
export function loadPersonaSeedFromEnv(env: NodeJS.ProcessEnv = process.env): PersonaSeed {
  return loadPersonaFromEnv(env).seed;
}
