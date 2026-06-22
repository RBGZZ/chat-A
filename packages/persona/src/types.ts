/**
 * 数值人格 + 情感内核类型(承 §6.1/§6.2)。数值范围约定:
 * - OCEAN 五维:用户直觉的 [0,1](0.5 中性);内部映射前居中到 [-1,1]。
 * - PAD 三维:[-1,1]。
 */

/** OCEAN 五维(Big Five),各 [0,1]。 */
export interface Ocean {
  readonly openness: number;
  readonly conscientiousness: number;
  readonly extraversion: number;
  readonly agreeableness: number;
  readonly neuroticism: number;
}

/** PAD 情感状态,各 [-1,1]。 */
export interface Pad {
  readonly pleasure: number;
  readonly arousal: number;
  readonly dominance: number;
}

/** 单轮施加到 PAD 的拉力(由 Appraiser 产出)。 */
export type PadPull = Pad;

/**
 * 用户可调旋钮(用户自治,§6.1)。全 [0,1],外置配置,无 magic number。
 * personality_* 影响姿态/主动性(P1 部分接入);emotion_* 调制 PAD 演化与 tone。
 */
export interface PersonaDials {
  // personality_dials
  readonly assertiveness: number;
  readonly negativeAffectExpression: number;
  readonly proactivity: number;
  readonly intimacyPace: number;
  // emotion_dials
  readonly emotionalIntensity: number;
  readonly emotionalVolatility: number;
  readonly baselineWarmth: number;
  readonly expressiveness: number;
}

/** 内核数值参数(行为即配置)。 */
export interface PersonaConfig {
  /** 冷启动窗口轮数:此窗口内情绪幅度减半 + 加速回弹。 */
  readonly coldStartTurns: number;
  /** 冷启动加速回弹系数(放大 spring k)。 */
  readonly coldStartReboundFactor: number;
}

/** 持久化快照:人格(OCEAN)+ 当前情感(PAD)+ 已历轮次。 */
export interface PersonaSnapshot {
  readonly ocean: Ocean;
  readonly pad: Pad;
  readonly turn: number;
}

/** 用户自定义人格种子(§6.2):身份/背景文本 + OCEAN + 旋钮。 */
export interface PersonaSeed {
  readonly name: string;
  /** 身份/背景/说话风格文本 → system 静态骨架。 */
  readonly identity: string;
  readonly ocean: Ocean;
  readonly dials: PersonaDials;
  readonly greetings?: readonly string[];
}

/** 离散情绪(P1 小集合,够 tone 区分)。 */
export type Emotion = 'joyful' | 'content' | 'neutral' | 'down' | 'irritated';

export interface AppraiseContext {
  readonly userText: string;
  readonly pad: Pad;
  readonly turn: number;
}

/** 情绪评估接缝(§3.1):每轮产出 PAD 拉力。可替换(默认确定性 / 未来 LLM)。 */
export interface Appraiser {
  appraise(ctx: AppraiseContext): PadPull;
}

/** 人格状态持久化接缝。 */
export interface PersonaStore {
  load(): PersonaSnapshot | null;
  save(snapshot: PersonaSnapshot): void;
}

/** 通用 KV 持久化(结构类型):@chat-a/memory 的 MemoryStore 结构上满足之,无需包级依赖。 */
export interface KvLike {
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
}
