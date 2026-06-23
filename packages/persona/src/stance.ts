import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { SelfNotion, StanceContext, StanceDetector, StanceResult } from './types';
import { SELF_NOTION_STRENGTH_FLOOR } from './defaults';
import { effectiveStrength } from './self-notions';

/**
 * 分歧检测(§7#3 会反对)。确定性默认实现只判"话题相关、她有立场",不臆测语义同异;
 * LLM 实现(可选)更精准地挑出"用户确在挑战的观点",失败降级。承 Appraiser 接缝风格。
 */

/** assertiveness 低于此档,默认检测器完全沉默(温和顺从,不主动摆观点)。外置,无 magic number。 */
export const STANCE_FLOOR = 0.2;
/** 单轮最多带出的观点条数(避免 prompt 噪声)。 */
export const STANCE_MAX_NOTIONS = 2;
/**
 * 低强度立场的额外压制门槛(§7#3 强度演化):assertiveness ≥ 此值时,即便立场弱也照常表达。
 * 低于此值且立场**显式**弱(strength < strengthFloor)→ 压制该条(更趋沉默)。
 * 缺省强度立场(=基线,高于 strengthFloor)不受此影响 → 现有行为不变。外置,无 magic number。
 */
export const STANCE_LOW_STRENGTH_ASSERT = 0.6;

/** 轻量归一(persona 自带,不引 memory 运行时依赖):小写化 + 去首尾空白。中文 includes 直接生效。 */
function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/** 一条观点在用户输入中的命中关键词数(话题相关度)。 */
function hitCount(userNorm: string, notion: SelfNotion): number {
  let n = 0;
  for (const kw of notion.topic) {
    const k = normalize(kw);
    if (k.length > 0 && userNorm.includes(k)) n++;
  }
  return n;
}

export interface DefaultStanceDetectorOptions {
  /** assertiveness 沉默门槛(默认 STANCE_FLOOR)。 */
  readonly floor?: number;
  /** 单轮最多观点数(默认 STANCE_MAX_NOTIONS)。 */
  readonly maxNotions?: number;
  /**
   * 立场强度压制门槛(§7#3 演化,默认 SELF_NOTION_STRENGTH_FLOOR)。
   * **显式**强度低于此值的立场,在 assertiveness < STANCE_LOW_STRENGTH_ASSERT 时被压制(更趋沉默)。
   * 缺省强度立场按基线处理(高于此门槛)→ 不受影响,现有命中行为不变。
   */
  readonly strengthFloor?: number;
  /** 低强度压制只在 assertiveness 低于此档时生效(默认 STANCE_LOW_STRENGTH_ASSERT)。 */
  readonly lowStrengthAssert?: number;
}

/**
 * 确定性分歧检测:对 self_notions 做话题关键词命中。assertiveness < floor → 沉默(空)。
 * 否则返回命中观点(按命中数降序,截断 maxNotions)。同步逻辑,异步签名仅为接缝统一。
 * 强度演化(§7#3):**显式**弱立场在较低 assertiveness 下被额外压制;缺省强度立场行为不变。
 */
export class DefaultStanceDetector implements StanceDetector {
  readonly #floor: number;
  readonly #maxNotions: number;
  readonly #strengthFloor: number;
  readonly #lowStrengthAssert: number;

  constructor(opts: DefaultStanceDetectorOptions = {}) {
    this.#floor = opts.floor ?? STANCE_FLOOR;
    this.#maxNotions = opts.maxNotions ?? STANCE_MAX_NOTIONS;
    this.#strengthFloor = opts.strengthFloor ?? SELF_NOTION_STRENGTH_FLOOR;
    this.#lowStrengthAssert = opts.lowStrengthAssert ?? STANCE_LOW_STRENGTH_ASSERT;
  }

  /** 强度压制:assertiveness 不够高时,过滤掉**显式**弱立场(缺省强度=基线,不被过滤)。 */
  #passesStrength(notion: SelfNotion, assertiveness: number): boolean {
    if (assertiveness >= this.#lowStrengthAssert) return true; // 够强势 → 弱立场也照说。
    return effectiveStrength(notion) >= this.#strengthFloor;
  }

  async detect(ctx: StanceContext): Promise<StanceResult> {
    if (ctx.assertiveness < this.#floor) return { notions: [] };
    const userNorm = normalize(ctx.userText);
    const scored = ctx.selfNotions
      .map((notion) => ({ notion, hits: hitCount(userNorm, notion) }))
      .filter((x) => x.hits > 0)
      .filter((x) => this.#passesStrength(x.notion, ctx.assertiveness))
      .sort((a, b) => b.hits - a.hits)
      .slice(0, this.#maxNotions)
      .map((x) => x.notion);
    return { notions: scored };
  }
}

export interface LlmStanceDetectorOptions {
  readonly provider: LlmProvider;
  /** LLM 失败/乱码时回退(默认确定性检测器)。 */
  readonly fallback?: StanceDetector;
  readonly maxTokens?: number;
  readonly onError?: (err: unknown) => void;
}

function buildPrompt(userText: string, notions: readonly SelfNotion[]): string {
  const list = notions.map((n, i) => `${i}. ${n.position}`).join('\n');
  return [
    '下面是"我"的若干观点(带编号),以及对话伙伴刚说的一句话。',
    '判断这句话**涉及或挑战**了我的哪几条观点(用户表达了相关或相左看法)。',
    '只输出 JSON 数组,元素是命中的编号(从0开始);没有则输出 []。',
    '示例:[0,2]',
    '我的观点:',
    list,
    `对方这句话:「${userText}」`,
  ].join('\n');
}

/** 把任意解析结果校验为合法下标数组。 */
function toIndices(v: unknown, count: number): number[] | null {
  if (!Array.isArray(v)) return null;
  const out: number[] = [];
  for (const x of v) {
    const n = typeof x === 'number' ? x : Number(x);
    if (Number.isInteger(n) && n >= 0 && n < count && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * LLM 分歧检测(可选)。complete + 要 JSON 下标数组 + 容错解析 → 命中观点。
 * 任何失败回退到 fallback(默认确定性),绝不打断回合(§3.2)。assertiveness < floor 仍沉默(走 fallback)。
 */
export class LlmStanceDetector implements StanceDetector {
  readonly #provider: LlmProvider;
  readonly #fallback: StanceDetector;
  readonly #maxTokens: number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmStanceDetectorOptions) {
    this.#provider = opts.provider;
    this.#fallback = opts.fallback ?? new DefaultStanceDetector();
    this.#maxTokens = opts.maxTokens ?? 100;
    this.#onError = opts.onError;
  }

  async detect(ctx: StanceContext): Promise<StanceResult> {
    // 温和顺从档或无观点:不调 LLM,直接走确定性(其会返回空)。
    if (ctx.assertiveness < STANCE_FLOOR || ctx.selfNotions.length === 0) {
      return this.#fallback.detect(ctx);
    }
    try {
      const text = await this.#provider.complete({
        system: '你是分歧检测器,只输出 JSON 数组,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(ctx.userText, ctx.selfNotions) }],
        maxTokens: this.#maxTokens,
      });
      const idx = toIndices(tolerantJsonParse(text), ctx.selfNotions.length);
      if (idx === null) throw new Error('stance 返回非下标数组');
      return { notions: idx.slice(0, STANCE_MAX_NOTIONS).map((i) => ctx.selfNotions[i]!) };
    } catch (err) {
      this.#onError?.(err);
      return this.#fallback.detect(ctx);
    }
  }
}
