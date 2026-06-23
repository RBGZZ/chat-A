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
  /** 二级 OCEAN delta 演化节拍:每多少轮触发一次信号分析(§6.1,默认 20)。 */
  readonly evolutionEveryTurns: number;
  /** 单次演化每维 OCEAN delta 上限(钳制,§6.1,默认 0.01)。 */
  readonly maxOceanDeltaPerStep: number;
}

/** OCEAN 五维微调量(二级演化产出,§6.1);各维通常极小并受 maxOceanDeltaPerStep 钳制。 */
export type OceanDelta = Ocean;

/**
 * 一次 OCEAN 演化的版本快照(§6.1 版本快照 history,承数据迁移纪律:可回溯/可回滚)。
 * before=旧 OCEAN(回滚目标),after=新 OCEAN,delta=实际应用(已钳制)的微调。
 */
export interface OceanDeltaSnapshot {
  readonly turn: number;
  /** ISO 时间戳(可回溯)。 */
  readonly at: string;
  readonly before: Ocean;
  readonly after: Ocean;
  readonly delta: OceanDelta;
}

/**
 * 持久化快照:人格(OCEAN)+ 当前情感(PAD)+ 已历轮次 + 可选演化 history。
 * history 为向后兼容的加法:旧快照无此字段,读回视作空(§3.2 迁移纪律)。
 */
export interface PersonaSnapshot {
  readonly ocean: Ocean;
  readonly pad: Pad;
  readonly turn: number;
  /** OCEAN 二级演化的版本快照序列(可选;缺省=尚无演化)。 */
  readonly history?: readonly OceanDeltaSnapshot[];
}

/** 二级 OCEAN 演化的输入(§6.1):本周期累积的近段对话 + 当前 OCEAN + 触发轮次。 */
export interface OceanEvolveContext {
  /** 本演化周期内累积的用户输入(近段对话信号)。 */
  readonly recentUserTexts: readonly string[];
  readonly ocean: Ocean;
  readonly turn: number;
}

/**
 * 二级 OCEAN 演化接缝(§3.1/§6.1):据近段对话产出 OCEAN 微调 delta。
 * 异步以容纳 LLM 实现;返回 null = 本次不演化(信号不足/失败降级)。
 * **无确定性默认实现**:性格漂移需语义理解,默认行为是"不注入即不演化"。
 */
export interface OceanEvolver {
  evolve(ctx: OceanEvolveContext): Promise<OceanDelta | null>;
}

/**
 * Agent 自己的一个观点/信念/好恶(§7#3 反对依据):
 * topic=可匹配的话题线索(关键词),position=她在该话题上的立场文本。
 *
 * 强度演化(§7#3 演化,纯加法):
 * - strength=立场强度 [0,1];缺省=未标注,按基线 SELF_NOTION_BASE_STRENGTH 处理(行为等价当前)。
 * - affirmCount=被确立/强化的次数;缺省=0。
 * 旧种子/旧快照无这两字段照常工作(向后兼容,§6.1 迁移纪律)。
 */
export interface SelfNotion {
  readonly topic: readonly string[];
  readonly position: string;
  readonly strength?: number;
  readonly affirmCount?: number;
}

/** 单条立场的一次强度增量请求(§7#3 演化):topicKey 定位立场,delta 为正向增量(只增不减)。 */
export interface SelfNotionStrengthDelta {
  /** 立场定位键(topic 首关键词归一,见 topicKeyOf)。 */
  readonly topicKey: string;
  /** 正向强度增量(实际应用前会被钳到 [0, maxStrengthDeltaPerStep])。 */
  readonly delta: number;
}

/**
 * 一次 self_notion 强度演化的版本快照(§6.1 history,可回溯/可回滚)。
 * before=旧 strength(回滚目标),after=新 strength,delta=实际应用(已钳制)的增量。
 */
export interface SelfNotionSnapshot {
  readonly turn: number;
  /** ISO 时间戳(可回溯)。 */
  readonly at: string;
  /** 哪条立场(topic 首关键词为键)。 */
  readonly topicKey: string;
  readonly before: number;
  readonly after: number;
  readonly delta: number;
}

/**
 * self_notions 持久化状态(§6.1 schema 带版本 + 迁移)。独立于 PersonaSnapshot(OCEAN/PAD)。
 * history 为向后兼容的加法:旧状态无此字段,读回视作空。
 */
export interface SelfNotionsState {
  /** schema 版本(当前 SELF_NOTIONS_SCHEMA_VERSION)。 */
  readonly version: number;
  /** 演化后的立场集(含强度)。 */
  readonly notions: readonly SelfNotion[];
  /** 强度演化版本快照序列(可选;缺省=尚无演化)。 */
  readonly history?: readonly SelfNotionSnapshot[];
}

/** self_notion 强度演化的输入(§7#3):本轮用户输入 + 当前立场 + 触发轮次。 */
export interface SelfNotionEvolveContext {
  readonly userText: string;
  readonly notions: readonly SelfNotion[];
  readonly turn: number;
}

/**
 * self_notion 强度演化接缝(§3.1/§7#3):据本轮对话判定"确立/强化"了哪些立场。
 * 异步以容纳 LLM 实现;返回 null/空 = 本次不演化(信号不足/失败降级)。
 * **无确定性默认实现**:确定性猜"立场被确立"不可信,默认行为是"不注入即不演化"。
 */
export interface SelfNotionEvolver {
  evolve(ctx: SelfNotionEvolveContext): Promise<readonly SelfNotionStrengthDelta[] | null>;
}

/** self_notions 状态持久化接缝(独立于 PersonaStore)。 */
export interface SelfNotionStore {
  load(): SelfNotionsState | null;
  save(state: SelfNotionsState): void;
}

/** 用户自定义人格种子(§6.2):身份/背景文本 + OCEAN + 旋钮 + 自我观点。 */
export interface PersonaSeed {
  readonly name: string;
  /** 身份/背景/说话风格文本 → system 静态骨架。 */
  readonly identity: string;
  readonly ocean: Ocean;
  readonly dials: PersonaDials;
  readonly greetings?: readonly string[];
  /** 她会坚持的观点(§7#3);缺省为空 = 无具体异议依据。 */
  readonly selfNotions?: readonly SelfNotion[];
}

/**
 * 用户手写的 PersonaCard(§6.2,card-as-config)的 YAML 形态。
 * 全字段可选:缺省回落默认种子;OCEAN/dials 部分子字段可选(逐字段回落)。
 * lore=角色背景/故事(→ subject=agent 可召回记忆,不进骨架);
 * userProfile=用户画像(→ subject=person 主用户种子记忆)。
 */
export interface PersonaCard {
  readonly name?: string;
  readonly identity?: string;
  readonly ocean?: Partial<Ocean>;
  readonly dials?: Partial<PersonaDials>;
  readonly greetings?: readonly string[];
  readonly lore?: readonly string[];
  readonly userProfile?: readonly string[];
  readonly selfNotions?: readonly SelfNotion[];
}

/**
 * 加载 PersonaCard 的产物:可直接喂 PersonaEngine 的种子 + 两个待"种子化"的列表。
 * 加载器只产数据,不碰 MemoryStore(接缝边界,§3.1);落库副作用留给编排层。
 */
export interface LoadedPersonaCard {
  readonly seed: PersonaSeed;
  /** 角色背景/故事 → subject=agent 记忆。 */
  readonly lore: readonly string[];
  /** 用户画像 → subject=person(主用户)记忆。 */
  readonly userProfile: readonly string[];
  /** 她的观点(§7#3)→ subject=agent 记忆;立场文本也供分歧检测。 */
  readonly selfNotions: readonly SelfNotion[];
}

/** 分歧检测输入(§7#3):本轮用户输入 + 她的观点 + assertiveness 旋钮。 */
export interface StanceContext {
  readonly userText: string;
  readonly selfNotions: readonly SelfNotion[];
  /** assertiveness 旋钮 [0,1];低=温和顺从,高=敢顶嘴。 */
  readonly assertiveness: number;
}

/** 分歧检测结果(§7#3):本轮话题相关、她有立场的观点(可空)。 */
export interface StanceResult {
  readonly notions: readonly SelfNotion[];
}

/**
 * 分歧检测接缝(§3.1/§7#3):据用户输入与 self_notions 产出本轮 stance。
 * 异步以容纳 LLM 实现;确定性实现返回已决议 Promise。只判"话题相关、她有立场",
 * 不臆测语义同异(冲突交由生成 LLM 判断)。
 */
export interface StanceDetector {
  detect(ctx: StanceContext): Promise<StanceResult>;
}

/** 离散情绪(P1 小集合,够 tone 区分)。 */
export type Emotion = 'joyful' | 'content' | 'neutral' | 'down' | 'irritated';

/**
 * 负面人际姿态(§7#6):在情绪之上的人际行为叠加层,仅负面区激活、由 negativeAffectExpression 门控。
 * sulking=赌气(心情差、唤起高、有气);withdrawn=冷淡抽离(心情差、唤起低、蔫);
 * cold=冷硬疏远(心情差但掌控感强:不闹不蔫,克制而有距离)。无姿态时为 null。
 */
export type Posture = 'sulking' | 'withdrawn' | 'cold';

export interface AppraiseContext {
  readonly userText: string;
  readonly pad: Pad;
  readonly turn: number;
}

/** 情绪评估接缝(§3.1):每轮产出 PAD 拉力。异步以容纳 LLM 实现;确定性实现返回已决议 Promise。 */
export interface Appraiser {
  appraise(ctx: AppraiseContext): Promise<PadPull>;
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
