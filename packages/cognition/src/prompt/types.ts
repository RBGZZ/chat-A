import type { MemoryRecord } from '@chat-a/memory';
import type { ChatMessage } from '@chat-a/protocol';

/**
 * prompt 组装接缝类型(承 §5.4 优先级 Injection 接缝)。
 *
 * 把"谁往 prompt 注入什么"(PromptContributor)与"如何拼装/裁剪"(PromptAssembler)解耦:
 * 各注入来源(人格骨架/记忆召回/tone,及后续 §7 情绪/未了话题/异议)各做一个 contributor,
 * 返回带 priority/tier 的 fragment;assembler 收集 → 升序拼接 → 预算裁剪 → cleanup。
 */

/** 注入档:核心 pinned 永驻、不参与预算裁剪;外围可裁(§5.4)。缺省按外围。 */
export type PromptTier = 'core' | 'peripheral';

/**
 * 本轮分歧检测结果(§7#3),由回合编排层据 StanceDetector + assertiveness 产出后填入 ctx。
 * cognition 自有最小形状,不依赖 persona 的 StanceResult 类型(松耦合)。
 */
export interface StanceInput {
  /** assertiveness 旋钮 [0,1];DissentContributor 据此分档与门控。 */
  readonly assertiveness: number;
  /** 本轮命中、她有立场的观点文本(可空)。 */
  readonly notions: readonly string[];
}

/**
 * 本轮自我一致性判定结果(§6.1),由回合编排层据 SelfConsistencyGuard 产出后填入 ctx。
 * cognition 自有最小形状,不依赖 persona 的 AnchorResult 类型(松耦合,同 StanceInput 手法)。
 */
export interface AnchorInput {
  /** 回复是否与确立过的核心自我矛盾(漂移);ReAnchorContributor 仅在 true 时注入重锚。 */
  readonly drift: boolean;
  /** 命中的核心锚点文本(供重锚提示「以此为准」);可空。 */
  readonly anchorText?: string;
}

/** 一个 contributor 本轮产出的注入片段。 */
export interface PromptFragment {
  /** 注入文本(空字符串视为有内容、照常拼;无内容应由 contributor 返回 null)。 */
  readonly text: string;
  /** 升序拼接:小=靠前(稳定/低注意力),大=靠近末尾(最近注意力)。 */
  readonly priority: number;
  /** 注入档;缺省 'peripheral'。'core' 段始终保留、不参与预算裁剪。 */
  readonly tier?: PromptTier;
}

/**
 * prompt 注入来源接缝(§5.4)。`contribute` MUST 同步、MUST NOT 引入额外 I/O 或网络调用
 * (承 §3.2 延迟预算:与现状一致,骨架/tone/关键词召回均同步)。
 */
export interface PromptContributor {
  /** 据组装上下文产出一段注入;无内容返回 null(不拼空段)。 */
  contribute(ctx: PromptContext): PromptFragment | null;
  /** 清理本轮一次性状态(§5.4);可选。 */
  cleanup?(): void;
}

/**
 * 组装上下文(§5.4 / design D2):字段严格来自当轮已有数据,由回合编排层(Conversation)填入。
 * assembler 不自行访问 MemoryStore / Persona(承 §3.1 接缝边界);取数与召回降级由编排层负责。
 */
export interface PromptContext {
  /** 人格骨架(buildSystemPrompt(seed) 的结果)。 */
  readonly skeleton: string;
  /** 记忆召回结果(memory.recall(userText);可空数组,召回抛错由编排层降级传空)。 */
  readonly recalled: readonly MemoryRecord[];
  /** 本轮 tone fragment(persona.tone().toneFragment)。 */
  readonly toneFragment: string;
  /** 本轮用户输入。 */
  readonly userText: string;
  /** 历史滑窗(memory.snapshot());裁剪在 assembler 内对其切片,不改 MemoryStore。 */
  readonly history: readonly ChatMessage[];
  /** 本轮分歧检测结果(§7#3);由编排层调 StanceDetector 产出,缺省/无异议时省略。 */
  readonly stance?: StanceInput;
  /** 本轮自我一致性判定结果(§6.1);由编排层调 SelfConsistencyGuard 产出,缺省/未漂移时省略。 */
  readonly anchor?: AnchorInput;
  /** expressiveness 旋钮值 [0,1](§7#4);由编排层据人格旋钮填入,微调风格强度。缺省时 StyleDisciplineContributor 回落中性档。 */
  readonly expressiveness?: number;
  /** volatile 上下文键值(时间戳/turnId 等),追加到末条用户消息(§5.4);P1 可空。 */
  readonly volatile?: ReadonlyArray<readonly [key: string, value: string]>;
}

/**
 * token 估算接缝(承 §5.4 预算管理):P1 用字符/近似 token,P2 可换真 tokenizer 不改 assembler。
 * 单一权威估算公式,避免多套估算漂移(行为即配置)。
 */
export interface TokenEstimator {
  estimate(text: string): number;
}

/** 预算/优先级等可配项(行为即配置,§3.1):阈值不散落成 magic number。 */
export interface PromptBudgetConfig {
  /** context 窗口总 token(估算口径);默认见 DEFAULT_BUDGET。 */
  readonly contextWindowTokens: number;
  /** 预算上限占窗口比例(默认 ~0.9,留尾部安全余量,§5.4)。 */
  readonly maxRatio: number;
  /** 字符→token 近似系数 K:estimate ≈ ceil(charCount / K)(混合中英取近似)。 */
  readonly charsPerToken: number;
}
