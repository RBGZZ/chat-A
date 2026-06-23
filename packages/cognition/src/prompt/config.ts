import type { PromptBudgetConfig, TokenEstimator } from './types';

/**
 * 三个内置 contributor 的 priority(带间隙的离散常量,§5.4 / design D4):
 * 升序拼接后顺序 = 骨架 → 记忆 → tone,与现状 parts 顺序一致(等价契约基础)。
 * 留间隙(100/500/900)供后续 §7 contributor(情绪/未了话题/异议)插空,外置可配。
 */
export const PROMPT_PRIORITY = {
  /** 人格骨架:最小(靠前/最稳定)。 */
  personaSkeleton: 100,
  /** 记忆召回:中。 */
  memoryRecall: 500,
  /** tone:大(靠近末尾/最近注意力)。 */
  tone: 900,
  /** 对话风格纪律(§7#4):tone 之后、dissent 之前的高注意力区——风格 steer 比"当前情绪"更想贴近末尾,但仍让立场/反谄媚压轴。 */
  style: 920,
  /** 异议(§7#3):tone 之后,作为本轮最强 steer(最靠近末尾)。 */
  dissent: 950,
} as const;

/**
 * expressiveness → 对话风格分档(§7#4,行为即配置,无 magic number):
 * < reservedCeil:含蓄档(更短、收敛口头禅/语气词);
 * [reservedCeil, expressiveFloor):中性档(默认,缺省 expressiveness 回落此档);
 * >= expressiveFloor:外放档(更多口头禅/语气词)。
 * 仅调"口头禅·语气词放开程度";硬纪律(禁"作为AI…"/禁过度解释/别像写文章/话短口语)三档恒守。
 */
// 阈值与 persona/tone.ts 的 expressiveness 分档对齐(0.34/0.66),避免同一旋钮双源漂移。
export const STYLE_EXPRESSIVENESS = {
  reservedCeil: 0.34,
  expressiveFloor: 0.66,
} as const;

/**
 * assertiveness → 异议分档(§7#3,行为即配置,无 magic number):
 * < submissiveCeil:温和顺从,不注入任何异议/基线;
 * [submissiveCeil, assertiveFloor):中等,委婉措辞;
 * >= assertiveFloor:有主见,直接措辞。
 */
export const DISSENT_ASSERTIVENESS = {
  submissiveCeil: 0.2,
  assertiveFloor: 0.6,
} as const;

/**
 * 默认字符/近似 token 估算(P1):estimate ≈ ceil(charCount / K)。
 * 单一权威公式(承 §5.4),P2 换真 tokenizer 时替换本实现即可,不改 assembler。
 */
export function makeCharTokenEstimator(charsPerToken: number): TokenEstimator {
  return {
    estimate: (text: string) => Math.ceil(text.length / charsPerToken),
  };
}

/** 默认预算配置(行为即配置):窗口/上限比例/估算 K 外置可调。 */
export const DEFAULT_BUDGET: PromptBudgetConfig = {
  // P1 取一个保守的中等窗口口径;现阶段 messages 量远未触顶,仅留裁剪接缝。
  contextWindowTokens: 8192,
  // ~90% 上限,留尾部安全余量(§5.4)。
  maxRatio: 0.9,
  // 混合中英近似:每 ~3 字符约 1 token。
  charsPerToken: 3,
};

/** 默认 token 估算器(据默认预算的 K)。 */
export const DEFAULT_TOKEN_ESTIMATOR: TokenEstimator = makeCharTokenEstimator(
  DEFAULT_BUDGET.charsPerToken,
);
