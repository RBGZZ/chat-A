import type { LoadedPersonaCard, PersonaConfig, PersonaDials, PersonaSeed } from './types';
import { loadPersonaCard } from './card-loader';
import { DEFAULT_PERSONA_CONFIG } from './defaults';

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

/** 解析非负数(冷启动轮数/回弹系数);非数/负数回落 fallback。 */
function numNonNeg(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** 解析情绪阈值 [0,1](阈值落在单位区间内才合法);非法/缺省回落 fallback。 */
function numThreshold(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

/**
 * 从 env 装配 PersonaConfig 的可调内核参数(行为即配置,§3.2;承 persona-tunable-seams)。
 * 默认全部 = DEFAULT_PERSONA_CONFIG(= 现值)→ **不设任何 env 时逐字零回归**。
 *   CHAT_A_COLD_START_TURNS            冷启动窗口轮数(非负;默认 5;设 0 = 关冷启动压制)
 *   CHAT_A_COLD_START_REBOUND          冷启动加速回弹系数(非负;默认 2)
 *   CHAT_A_EMOTION_PLEASURE_THRESHOLD  PAD→情绪 Pleasure 阈值 [0,1](默认 0.35;调低=情绪更易动)
 *   CHAT_A_EMOTION_AROUSAL_THRESHOLD   PAD→情绪 Arousal 阈值 [0,1](默认 0.25)
 * 非法/缺省值逐字段回落现值(不整体丢弃)。其余内核参数(evolutionEveryTurns / maxOceanDeltaPerStep)沿用默认(本 change 不暴露)。
 */
export function loadPersonaConfigFromEnv(env: NodeJS.ProcessEnv = process.env): PersonaConfig {
  return {
    ...DEFAULT_PERSONA_CONFIG,
    coldStartTurns: numNonNeg(env['CHAT_A_COLD_START_TURNS'], DEFAULT_PERSONA_CONFIG.coldStartTurns),
    coldStartReboundFactor: numNonNeg(
      env['CHAT_A_COLD_START_REBOUND'],
      DEFAULT_PERSONA_CONFIG.coldStartReboundFactor,
    ),
    emotion: {
      pleasureThreshold: numThreshold(
        env['CHAT_A_EMOTION_PLEASURE_THRESHOLD'],
        DEFAULT_PERSONA_CONFIG.emotion.pleasureThreshold,
      ),
      arousalThreshold: numThreshold(
        env['CHAT_A_EMOTION_AROUSAL_THRESHOLD'],
        DEFAULT_PERSONA_CONFIG.emotion.arousalThreshold,
      ),
    },
  };
}
