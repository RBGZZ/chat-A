import type { PersonaConfig, PersonaDials, SelfConsistencyConfig } from './types';

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

/**
 * padToEmotion 阈值默认值(= 历史硬编码 0.35/0.25)。padToEmotion 的可选阈值参缺省也回落到这两个值,
 * 故无参调用(老调用点)行为逐字不变;DEFAULT_PERSONA_CONFIG.emotion 复用之,单一权威。
 */
export const DEFAULT_PLEASURE_THRESHOLD = 0.35;
export const DEFAULT_AROUSAL_THRESHOLD = 0.25;

export const DEFAULT_PERSONA_CONFIG: PersonaConfig = {
  coldStartTurns: 5,
  coldStartReboundFactor: 2,
  evolutionEveryTurns: 20,
  maxOceanDeltaPerStep: 0.01,
  emotion: {
    pleasureThreshold: DEFAULT_PLEASURE_THRESHOLD,
    arousalThreshold: DEFAULT_AROUSAL_THRESHOLD,
  },
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

/**
 * 自我一致性锚定的外置常量(§6.1,行为即配置、无 magic number)。
 */
/** 缺省配置:**默认关**(缺省安全,行为字面不变);锚点范围默认保守 core-only。 */
export const DEFAULT_SELF_CONSISTENCY_CONFIG: SelfConsistencyConfig = {
  enabled: false,
  strictness: 'core-only',
};
/**
 * 否定线索词(确定性 Guard 用):回复出现这些词且邻近核心锚点关键词 → 候选漂移。
 * 中文 includes 直接生效;外置可扩。**只覆盖"否定自我断言"的口径**,不含"我不同意(你)"那类对外异议。
 */
export const NEGATION_CUES: readonly string[] = [
  '我不叫',
  '我不是',
  '我没有',
  '我不再',
  '我再也不',
  '我不相信',
  '我并不',
  '我才不',
  '其实我不',
  '我从来不是',
];
/** 锚点关键词最小长度:短于此的关键词不参与命中(避免单字噪声误伤)。 */
export const ANCHOR_KEYWORD_MIN_LEN = 2;
/**
 * 第一人称肯定前缀(确定性 Guard 抽关键词用):从核心自我记忆里剥去这些前缀,
 * 得到"断言内容"关键词(如「我相信慢下来更有味道」→「慢下来更有味道」),
 * 使其能与回复里否定线索词(「我不相信…」)之后的残余内容对齐。外置可扩。
 */
export const SELF_AFFIRMATION_PREFIXES: readonly string[] = [
  '我相信',
  '我是',
  '我叫',
  '我喜欢',
  '我觉得',
  '我认为',
  '我热爱',
  '我向来',
  '我一直',
];
/**
 * 否定线索与锚点关键词的邻接窗口(字符数):否定线索词起点与锚点关键词出现位置之差在此窗口内,
 * 才记为"否定邻接该锚点"(避免一句里偶然各自出现就误判)。
 */
export const ANCHOR_ADJACENCY_WINDOW = 12;

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
