import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { SelfNotion, SelfNotionEvolveContext, SelfNotionEvolver, SelfNotionStrengthDelta } from './types';
import { topicKeyOf } from './self-notions';
import { MAX_STRENGTH_DELTA_PER_STEP } from './defaults';

export interface LlmSelfNotionEvolverOptions {
  readonly provider: LlmProvider;
  /** 单次强度增量上限(钳制提示;最终钳制由 SelfNotionsManager 兜底)。默认 MAX_STRENGTH_DELTA_PER_STEP。 */
  readonly maxDelta?: number;
  readonly maxTokens?: number;
  readonly onError?: (err: unknown) => void;
}

function buildPrompt(userText: string, notions: readonly SelfNotion[], maxDelta: number): string {
  const list = notions.map((n, i) => `${i}. ${n.position}`).join('\n');
  return [
    '下面是"我"的若干立场(带编号),以及对话伙伴刚说的一句话。',
    '判断这句话是否**确立或强化**了我的某些立场(对方认同、印证、让我更坚定)。',
    `只输出 JSON 数组,元素 {"i":编号,"delta":正的小增量}(delta 接近 0,范围 (0, ${maxDelta}]);没有则输出 []。`,
    '立场只会被"强化",不会被削弱;绝大多数情况下应为 []。',
    '示例:[{"i":1,"delta":0.03}]',
    '我的立场:',
    list,
    `对方这句话:「${userText}」`,
  ].join('\n');
}

/** 把解析结果校验为合法增量请求;映射编号→topicKey。无有效项→[]。 */
function toDeltas(v: unknown, notions: readonly SelfNotion[], maxDelta: number): SelfNotionStrengthDelta[] {
  if (!Array.isArray(v)) return [];
  const out: SelfNotionStrengthDelta[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const i = typeof o['i'] === 'number' ? o['i'] : Number(o['i']);
    const d = typeof o['delta'] === 'number' ? o['delta'] : Number(o['delta']);
    if (!Number.isInteger(i) || i < 0 || i >= notions.length) continue;
    if (!Number.isFinite(d) || d <= 0) continue; // 只增不减,非正跳过。
    const key = topicKeyOf(notions[i]!);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ topicKey: key, delta: Math.min(d, maxDelta) });
  }
  return out;
}

/**
 * LLM 驱动的 self_notion 强度演化(§7#3)。complete + 要 JSON + 容错解析 → 增量请求。
 * 任何失败(异常/乱码/无有效项)→ 返回 null(本次不演化),manager 跳过、立场不变、回合不受影响(§3.2)。
 * 默认关:仅当显式注入时才被调用。最终钳制由 SelfNotionsManager(clampStrengthDelta)兜底。
 */
export class LlmSelfNotionEvolver implements SelfNotionEvolver {
  readonly #provider: LlmProvider;
  readonly #maxDelta: number;
  readonly #maxTokens: number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmSelfNotionEvolverOptions) {
    this.#provider = opts.provider;
    this.#maxDelta = opts.maxDelta ?? MAX_STRENGTH_DELTA_PER_STEP;
    this.#maxTokens = opts.maxTokens ?? 150;
    this.#onError = opts.onError;
  }

  async evolve(ctx: SelfNotionEvolveContext): Promise<readonly SelfNotionStrengthDelta[] | null> {
    if (ctx.notions.length === 0) return null;
    try {
      const text = await this.#provider.complete({
        system: '你是立场强化检测器,只输出 JSON 数组,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(ctx.userText, ctx.notions, this.#maxDelta) }],
        maxTokens: this.#maxTokens,
      });
      const deltas = toDeltas(tolerantJsonParse(text), ctx.notions, this.#maxDelta);
      return deltas.length > 0 ? deltas : null;
    } catch (err) {
      this.#onError?.(err);
      return null;
    }
  }
}
