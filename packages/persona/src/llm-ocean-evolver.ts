import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { OceanDelta, OceanEvolveContext, OceanEvolver } from './types';
import { clampOceanDelta } from './ocean-evolution';
import { DEFAULT_PERSONA_CONFIG } from './defaults';

export interface LlmOceanEvolverOptions {
  readonly provider: LlmProvider;
  /** 单次每维 delta 上限(钳制);默认取 DEFAULT_PERSONA_CONFIG.maxOceanDeltaPerStep。 */
  readonly maxDelta?: number;
  readonly maxTokens?: number;
  readonly onError?: (err: unknown) => void;
}

function buildPrompt(recentUserTexts: readonly string[]): string {
  const convo = recentUserTexts.map((t) => `- ${t}`).join('\n');
  return [
    '下面是近段时间对方(用户)说过的话。请据此判断:这段相处是否在极其缓慢地改变倾听者的性格(OCEAN 五维)。',
    '只输出 JSON,含五个极小的微调量(每个都应接近 0,范围 [-0.01,0.01]):',
    'openness(开放性)、conscientiousness(尽责性)、extraversion(外向性)、agreeableness(宜人性)、neuroticism(神经质)。',
    '性格演化极慢:绝大多数情况下应几乎为 0;只有明确、反复的信号才给出非零微调。',
    '示例:{"openness":0.002,"conscientiousness":0,"extraversion":0.005,"agreeableness":0.003,"neuroticism":-0.004}',
    '近段对话:',
    convo,
  ].join('\n');
}

/** 把任意解析结果校验/钳制为合法 OceanDelta;无任何有效维度则 null。 */
function toDelta(v: unknown, maxDelta: number): OceanDelta | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
  const op = num(o['openness']);
  const co = num(o['conscientiousness']);
  const ex = num(o['extraversion']);
  const ag = num(o['agreeableness']);
  const ne = num(o['neuroticism']);
  if (op === null && co === null && ex === null && ag === null && ne === null) return null;
  return clampOceanDelta(
    {
      openness: op ?? 0,
      conscientiousness: co ?? 0,
      extraversion: ex ?? 0,
      agreeableness: ag ?? 0,
      neuroticism: ne ?? 0,
    },
    maxDelta,
  );
}

/**
 * LLM 驱动的二级 OCEAN 演化(承 §6.1 delta 演化)。complete + 要 JSON + 容错解析 → 钳制后的 OceanDelta。
 * 任何失败(异常/乱码/无有效维度)→ 返回 null(本次不演化),engine 跳过,人格不变、回合不受影响(§3.2)。
 * 默认关:仅当显式注入到 PersonaEngine 时才会被调用。
 */
export class LlmOceanEvolver implements OceanEvolver {
  readonly #provider: LlmProvider;
  readonly #maxDelta: number;
  readonly #maxTokens: number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmOceanEvolverOptions) {
    this.#provider = opts.provider;
    this.#maxDelta = opts.maxDelta ?? DEFAULT_PERSONA_CONFIG.maxOceanDeltaPerStep;
    this.#maxTokens = opts.maxTokens ?? 200;
    this.#onError = opts.onError;
  }

  async evolve(ctx: OceanEvolveContext): Promise<OceanDelta | null> {
    try {
      const text = await this.#provider.complete({
        system: '你是性格演化分析器,只输出 JSON,不要解释。性格变化极慢,默认接近 0。',
        messages: [{ role: 'user', content: buildPrompt(ctx.recentUserTexts) }],
        maxTokens: this.#maxTokens,
      });
      return toDelta(tolerantJsonParse(text), this.#maxDelta);
    } catch (err) {
      this.#onError?.(err);
      return null; // 失败降级:本次不演化。
    }
  }
}
