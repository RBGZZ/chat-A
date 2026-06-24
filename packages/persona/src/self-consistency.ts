import type {
  AnchorResult,
  SelfConsistencyConfig,
  SelfConsistencyContext,
  SelfConsistencyDecision,
  SelfConsistencyGuard,
  SelfMemoryRef,
} from './types';
import {
  ANCHOR_ADJACENCY_WINDOW,
  ANCHOR_KEYWORD_MIN_LEN,
  DEFAULT_SELF_CONSISTENCY_CONFIG,
  NEGATION_CUES,
  SELF_AFFIRMATION_PREFIXES,
} from './defaults';

/**
 * 自我一致性锚定:确定性默认 Guard(§6.1)。
 *
 * 设计纪律:
 * - **保守内核**:只判"回复**显式否定**了核心锚点(name / 核心档自我记忆)",不臆测语义矛盾
 *   (语义级判定交 opt-in LLM Guard;承 §3.2「能用代码算的才算,算不准的不假装」)。
 * - **放宽阈值(§6.1)**:观点变化、"我不同意(你)"、新喜好、情绪波动**绝不命中**——它们不否定核心自我设定。
 * - **缺省安全**:`enabled=false`(默认)时对任何输入返回 `{drift:false}`,行为字面等价不锚定。
 * - **优雅降级(§3.2)**:无锚点/无否定线索 → 不漂移、不抛。
 * - 纯函数核心,可写 golden test。
 */

/** 轻量归一(与 stance/self-notions 一致):小写化 + 去首尾空白。中文 includes 直接生效。 */
function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * 从一条核心自我记忆里抽"锚定关键词"(确定性、不做语义):
 * 1) 以标点/空白切分,保留长度 >= minLen 的片段(中英混合);
 * 2) 对每个片段再剥去常见"第一人称肯定前缀"(如「我相信」「我是」「我叫」),
 *    得到**断言内容关键词**(如「慢下来更有味道」「努力有用」)——使其能与回复里
 *    否定线索词(「我不相信」…)之后的残余内容对齐。**纯启发,不依赖 NLP/分词。**
 * 同时保留原片段(短 name 类记忆无前缀可剥时仍可命中)。
 */
function extractAnchorKeywords(text: string, minLen: number): string[] {
  const norm = normalize(text);
  // 以标点/空白切分(中英混合):保留连续的字母数字汉字片段。
  const parts = norm.split(/[^\p{L}\p{N}]+/u).filter((p) => p.length >= minLen);
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string): void => {
    if (p.length >= minLen && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const p of parts) {
    push(p);
    // 剥去第一人称肯定前缀,补一条"断言内容"关键词。
    for (const pre of SELF_AFFIRMATION_PREFIXES) {
      const preNorm = normalize(pre);
      if (preNorm.length > 0 && p.startsWith(preNorm) && p.length > preNorm.length) {
        push(p.slice(preNorm.length));
      }
    }
  }
  return out;
}

export interface DefaultSelfConsistencyGuardOptions {
  /** 锚定配置(默认 DEFAULT_SELF_CONSISTENCY_CONFIG:enabled=false 缺省安全)。 */
  readonly config?: SelfConsistencyConfig;
  /** 否定线索词表(默认 NEGATION_CUES);外置可扩。 */
  readonly negationCues?: readonly string[];
  /** 锚点关键词最小长度(默认 ANCHOR_KEYWORD_MIN_LEN)。 */
  readonly keywordMinLen?: number;
  /** 否定线索↔锚点关键词邻接窗口(默认 ANCHOR_ADJACENCY_WINDOW)。 */
  readonly adjacencyWindow?: number;
  /** 判定 trace sink(§8.1,可选;不注入=不记)。 */
  readonly onDecision?: (d: SelfConsistencyDecision) => void;
}

/**
 * 选出本轮要锚定的核心锚点:
 * - name(若有)恒为最强锚点;
 * - core-only(默认):仅 selfMemories 中 `core===true` 的条目;
 * - all-self:放宽到全部注入的自我记忆。
 * 返回 [{ keyword, sourceText }],keyword 为命中用关键词(归一),sourceText 为重锚提示用原文。
 */
function selectAnchors(
  ctx: SelfConsistencyContext,
  strictness: SelfConsistencyConfig['strictness'],
  minLen: number,
): Array<{ keyword: string; sourceText: string }> {
  const anchors: Array<{ keyword: string; sourceText: string }> = [];
  if (ctx.agentName !== undefined && ctx.agentName.trim().length > 0) {
    const kw = normalize(ctx.agentName);
    if (kw.length >= 1) anchors.push({ keyword: kw, sourceText: ctx.agentName.trim() });
  }
  const mems: readonly SelfMemoryRef[] =
    strictness === 'all-self' ? ctx.selfMemories : ctx.selfMemories.filter((m) => m.core === true);
  for (const m of mems) {
    for (const kw of extractAnchorKeywords(m.text, minLen)) {
      anchors.push({ keyword: kw, sourceText: m.text });
    }
  }
  return anchors;
}

/**
 * 判定回复是否"否定了某核心锚点":回复中出现否定线索词,且其位置邻接某锚点关键词(同窗口)。
 * 命中返回该锚点原文;否则 null。纯函数。
 */
function findNegatedAnchor(
  replyNorm: string,
  anchors: Array<{ keyword: string; sourceText: string }>,
  negationCues: readonly string[],
  window: number,
): { anchorText: string; cue: string } | null {
  for (const cue of negationCues) {
    const cueNorm = normalize(cue);
    if (cueNorm.length === 0) continue;
    let from = 0;
    // 该否定线索可能多次出现,逐处检查邻接。
    for (;;) {
      const at = replyNorm.indexOf(cueNorm, from);
      if (at < 0) break;
      const cueEnd = at + cueNorm.length;
      for (const a of anchors) {
        const ki = replyNorm.indexOf(a.keyword);
        if (ki < 0) continue;
        // 邻接:锚点关键词出现在否定线索词的起点附近(线索词后紧跟,或前后窗口内)。
        if (ki >= at - window && ki <= cueEnd + window) {
          return { anchorText: a.sourceText, cue };
        }
      }
      from = at + 1;
    }
  }
  return null;
}

export class DefaultSelfConsistencyGuard implements SelfConsistencyGuard {
  readonly #config: SelfConsistencyConfig;
  readonly #negationCues: readonly string[];
  readonly #keywordMinLen: number;
  readonly #adjacencyWindow: number;
  readonly #onDecision: ((d: SelfConsistencyDecision) => void) | undefined;

  constructor(opts: DefaultSelfConsistencyGuardOptions = {}) {
    this.#config = opts.config ?? DEFAULT_SELF_CONSISTENCY_CONFIG;
    this.#negationCues = opts.negationCues ?? NEGATION_CUES;
    this.#keywordMinLen = opts.keywordMinLen ?? ANCHOR_KEYWORD_MIN_LEN;
    this.#adjacencyWindow = opts.adjacencyWindow ?? ANCHOR_ADJACENCY_WINDOW;
    this.#onDecision = opts.onDecision;
  }

  async check(ctx: SelfConsistencyContext): Promise<AnchorResult> {
    // 缺省安全:未启用 → 永远不锚定(行为字面不变)。
    if (!this.#config.enabled) {
      return this.#emit({ drift: false });
    }
    const anchors = selectAnchors(ctx, this.#config.strictness, this.#keywordMinLen);
    if (anchors.length === 0) {
      return this.#emit({ drift: false }); // 无可锚定的核心自我 → 降级不锚定。
    }
    const replyNorm = normalize(ctx.reply);
    const hit = findNegatedAnchor(replyNorm, anchors, this.#negationCues, this.#adjacencyWindow);
    if (hit === null) {
      // 无"否定邻接核心锚点" → 不漂移(观点偏离/不同意/新喜好天然落此分支,放宽阈值)。
      return this.#emit({ drift: false });
    }
    return this.#emit({
      drift: true,
      reason: `回复疑似否定核心自我设定(否定线索「${hit.cue}」邻接锚点)`,
      anchorText: hit.anchorText,
    });
  }

  /** 调 sink(若有)后返回结果。纯转发,不改判定。 */
  #emit(r: AnchorResult): AnchorResult {
    this.#onDecision?.({
      drift: r.drift,
      mode: 'default',
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.anchorText !== undefined ? { anchorText: r.anchorText } : {}),
    });
    return r;
  }
}
