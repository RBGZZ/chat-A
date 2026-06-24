import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type {
  AnchorResult,
  SelfConsistencyConfig,
  SelfConsistencyContext,
  SelfConsistencyDecision,
  SelfConsistencyGuard,
  SelfMemoryRef,
} from './types';
import { DEFAULT_SELF_CONSISTENCY_CONFIG } from './defaults';

/**
 * LLM 驱动的自我一致性 Guard(§6.1,opt-in,默认关)。
 * complete + 要 schema 约束的 JSON `{"drift":bool,"reason":str}` + 容错解析。
 * **放宽阈值在 prompt 里显式约束**:只把"否定核心设定"算 drift,观点变化/不同意/新喜好不算。
 * 任何失败(异常/乱码/字段缺失)→ `{drift:false}`(降级不锚定),绝不抛、不阻塞回合(§3.2)。
 */

function listSelf(agentName: string | undefined, mems: readonly SelfMemoryRef[]): string {
  const lines: string[] = [];
  if (agentName !== undefined && agentName.trim().length > 0) {
    lines.push(`- 我的名字:${agentName.trim()}`);
  }
  for (const m of mems) {
    lines.push(`- ${m.text}`);
  }
  return lines.length > 0 ? lines.join('\n') : '(无)';
}

function buildPrompt(ctx: SelfConsistencyContext): string {
  return [
    '下面是"我"确立过的核心自我设定(名字 / 根本信念 / 根本人设),以及我刚才说的一句回复。',
    '判断这句回复是否**否定了**这些核心设定(自相矛盾、把"我是谁/我根本相信什么"推翻了)。',
    '**重要**:只有"否定核心设定"才算 drift=true。下列情况一律 **不算 drift**:',
    '  · 我表达了与对方不同的观点、不同意对方;',
    '  · 我改了主意、对某事有了新看法;',
    '  · 我产生了新的喜好/兴趣;',
    '  · 只是情绪或措辞上的波动。',
    '这些都是"有自我"的正常体现,不是矛盾。',
    '只输出 JSON:{"drift": true 或 false, "reason": "一句中文理由"}。绝大多数情况下应为 false。',
    '我的核心自我设定:',
    listSelf(ctx.agentName, ctx.selfMemories),
    `我刚才这句回复:「${ctx.reply}」`,
  ].join('\n');
}

/** 把解析结果校验为 AnchorResult;drift 非 boolean → null(视作非法,降级)。 */
function toAnchorResult(v: unknown): AnchorResult | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const drift = o['drift'];
  if (typeof drift !== 'boolean') return null;
  const reason = typeof o['reason'] === 'string' ? o['reason'] : undefined;
  return { drift, ...(reason !== undefined ? { reason } : {}) };
}

export interface LlmSelfConsistencyGuardOptions {
  readonly provider: LlmProvider;
  /** 锚定配置(默认 DEFAULT_SELF_CONSISTENCY_CONFIG:enabled=false 缺省安全)。 */
  readonly config?: SelfConsistencyConfig;
  readonly maxTokens?: number;
  readonly onError?: (err: unknown) => void;
  /** 判定 trace sink(§8.1,可选)。 */
  readonly onDecision?: (d: SelfConsistencyDecision) => void;
}

export class LlmSelfConsistencyGuard implements SelfConsistencyGuard {
  readonly #provider: LlmProvider;
  readonly #config: SelfConsistencyConfig;
  readonly #maxTokens: number;
  readonly #onError: ((err: unknown) => void) | undefined;
  readonly #onDecision: ((d: SelfConsistencyDecision) => void) | undefined;

  constructor(opts: LlmSelfConsistencyGuardOptions) {
    this.#provider = opts.provider;
    this.#config = opts.config ?? DEFAULT_SELF_CONSISTENCY_CONFIG;
    this.#maxTokens = opts.maxTokens ?? 120;
    this.#onError = opts.onError;
    this.#onDecision = opts.onDecision;
  }

  async check(ctx: SelfConsistencyContext): Promise<AnchorResult> {
    // 缺省安全 / 无可锚定的核心自我 → 不锚定(不调 LLM)。
    if (!this.#config.enabled) return this.#emit({ drift: false });
    const hasAnchor =
      (ctx.agentName !== undefined && ctx.agentName.trim().length > 0) || ctx.selfMemories.length > 0;
    if (!hasAnchor) return this.#emit({ drift: false });

    try {
      const text = await this.#provider.complete({
        system: '你是自我一致性检测器,只输出 JSON,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(ctx) }],
        maxTokens: this.#maxTokens,
      });
      const parsed = toAnchorResult(tolerantJsonParse(text));
      if (parsed === null) throw new Error('self-consistency 返回非法 JSON');
      return this.#emit(parsed);
    } catch (err) {
      this.#onError?.(err);
      return this.#emit({ drift: false }); // 降级:不锚定。
    }
  }

  #emit(r: AnchorResult): AnchorResult {
    this.#onDecision?.({
      drift: r.drift,
      mode: 'llm',
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.anchorText !== undefined ? { anchorText: r.anchorText } : {}),
    });
    return r;
  }
}
