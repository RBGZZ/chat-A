import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { Appraiser, AppraiseContext, PadPull } from './types';
import { DefaultAppraiser } from './appraiser';
import { clampUnit } from './defaults';

export interface LlmAppraiserOptions {
  readonly provider: LlmProvider;
  /** LLM 失败/乱码时的回退评估器(默认确定性)。 */
  readonly fallback?: Appraiser;
  readonly maxTokens?: number;
  readonly onError?: (err: unknown) => void;
}

function buildPrompt(userText: string): string {
  return [
    '判断下面这句话给倾听者(对话伙伴)带来的即时情绪变化。',
    '只输出 JSON,含三个 [-1,1] 的数:',
    'pleasure(愉悦:正=开心/被取悦,负=难过/被冒犯)、',
    'arousal(唤醒:正=激动/紧张,负=平静/松弛)、',
    'dominance(掌控:正=自信/主动,负=无力/被压)。',
    '示例:{"pleasure":-0.4,"arousal":0.3,"dominance":-0.2}',
    `这句话:「${userText}」`,
  ].join('\n');
}

/** 把任意解析结果校验/钳制为合法 PadPull;无任何有效维度则 null。 */
function toPull(v: unknown): PadPull | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? clampUnit(x) : null);
  const p = num(o['pleasure']);
  const a = num(o['arousal']);
  const d = num(o['dominance']);
  if (p === null && a === null && d === null) return null;
  return { pleasure: p ?? 0, arousal: a ?? 0, dominance: d ?? 0 };
}

/**
 * LLM 情绪评估(承 §6.1 即时 OCC→PAD)。complete + 要 JSON + 容错解析 → PadPull。
 * 任何失败(异常/乱码/无有效维度)回退到确定性 fallback,绝不打断回合(§3.2)。
 */
export class LlmAppraiser implements Appraiser {
  readonly #provider: LlmProvider;
  readonly #fallback: Appraiser;
  readonly #maxTokens: number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmAppraiserOptions) {
    this.#provider = opts.provider;
    this.#fallback = opts.fallback ?? new DefaultAppraiser();
    this.#maxTokens = opts.maxTokens ?? 200;
    this.#onError = opts.onError;
  }

  async appraise(ctx: AppraiseContext): Promise<PadPull> {
    try {
      const text = await this.#provider.complete({
        system: '你是情绪分析器,只输出 JSON,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(ctx.userText) }],
        maxTokens: this.#maxTokens,
      });
      const pull = toPull(tolerantJsonParse(text));
      if (pull === null) throw new Error('appraisal 返回无有效 PAD 维度');
      return pull;
    } catch (err) {
      this.#onError?.(err);
      return this.#fallback.appraise(ctx);
    }
  }
}
