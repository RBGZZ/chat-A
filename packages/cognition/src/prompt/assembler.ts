import type { ChatMessage } from '@chat-a/protocol';
import { DEFAULT_BUDGET, DEFAULT_TOKEN_ESTIMATOR, makeCharTokenEstimator } from './config';
import type {
  PromptBudgetConfig,
  PromptContext,
  PromptContributor,
  PromptFragment,
  TokenEstimator,
} from './types';

/** assembler 输出:与现状交给 llm.stream 的 { system, messages } 同形。 */
export interface AssembledPrompt {
  readonly system: string;
  readonly messages: ChatMessage[];
}

export interface PromptAssemblerOptions {
  /** token 估算接缝(§5.4);默认字符/近似 token。 */
  readonly tokenEstimator?: TokenEstimator;
  /** 预算配置(行为即配置);默认 DEFAULT_BUDGET。 */
  readonly budget?: PromptBudgetConfig;
  /** 降级记录回调(§3.2/§8.1):单 contributor 抛错时调用;默认 console.warn。 */
  readonly onError?: (err: unknown, phase: 'contribute' | 'cleanup') => void;
}

/**
 * PromptAssembler(§5.4 / design D3):收集各 contributor 非空 fragment → 按 priority 升序
 * 稳定排序 → 拼 system(段间 `\n\n`,与现状一致)→ messages=[...history, userMsg]
 * (volatile 以扁平 `[Context]` bullet 追加末条用户消息)→ 超预算从最旧 history 裁
 * (core 段与当轮 userMsg 永不裁)→ 对所有被调过的 contributor cleanup。
 *
 * 单 contributor contribute/cleanup 抛错 → try/catch 跳过该段、记 warn,不中断回合(§3.2);
 * 至少骨架段保底,prompt 不空。assembler 实例在 Conversation 构造期建好、稳定供 KV 复用。
 */
export class PromptAssembler {
  readonly #contributors: readonly PromptContributor[];
  readonly #estimator: TokenEstimator;
  readonly #budget: PromptBudgetConfig;
  readonly #onError: (err: unknown, phase: 'contribute' | 'cleanup') => void;

  constructor(contributors: readonly PromptContributor[], opts: PromptAssemblerOptions = {}) {
    this.#contributors = contributors;
    this.#budget = opts.budget ?? DEFAULT_BUDGET;
    // 估算器:显式注入优先;否则按预算的 K 取默认字符估算(单一权威公式)。
    this.#estimator =
      opts.tokenEstimator ??
      (opts.budget ? makeCharTokenEstimator(opts.budget.charsPerToken) : DEFAULT_TOKEN_ESTIMATOR);
    this.#onError = opts.onError ?? ((err, phase) => console.warn(`[prompt] contributor ${phase} 失败,跳过该段`, err));
  }

  assemble(ctx: PromptContext): AssembledPrompt {
    // 1. 收集:逐个 contribute,非空 fragment 入列;抛错跳过该段、记 warn,不中断(§3.2)。
    //    记录"被调用过的" contributor 供组装后 cleanup(无论是否产出)。
    const fragments: { frag: PromptFragment; order: number }[] = [];
    const called: PromptContributor[] = [];
    this.#contributors.forEach((c, order) => {
      called.push(c);
      try {
        const frag = c.contribute(ctx);
        if (frag !== null) fragments.push({ frag, order });
      } catch (err) {
        this.#onError(err, 'contribute');
      }
    });

    try {
      // 2. 升序稳定排序:priority 小靠前;同 priority 保注册序(以 order 为次键稳定)。
      fragments.sort((a, b) => a.frag.priority - b.frag.priority || a.order - b.order);

      // 3. 拼 system(段间 `\n\n`,与现状一致)。core 档始终保留(P1 无裁 system 段,
      //    此处所有 fragment 都进 system;volatile 不进 system,保 KV 稳定前缀)。
      const system = fragments.map((f) => f.frag.text).join('\n\n');

      // 4. 拼 messages:[...history, userMsg];volatile 以扁平 bullet 追加末条用户消息(§5.4)。
      const userMsg: ChatMessage = { role: 'user', content: this.#withVolatile(ctx.userText, ctx.volatile) };
      const history = [...ctx.history];

      // 5. 预算裁剪:估算 system + messages 超上限则从 history 最旧端逐条丢弃;
      //    core 段(已在 system)与当轮 userMsg 永不裁。
      const maxTokens = Math.floor(this.#budget.contextWindowTokens * this.#budget.maxRatio);
      const systemTokens = this.#estimator.estimate(system);
      const userTokens = this.#estimator.estimate(userMsg.content);
      let historyTokens = history.reduce((sum, m) => sum + this.#estimator.estimate(m.content), 0);
      while (history.length > 0 && systemTokens + historyTokens + userTokens > maxTokens) {
        const dropped = history.shift()!;
        historyTokens -= this.#estimator.estimate(dropped.content);
      }

      const messages: ChatMessage[] = [...history, userMsg];
      return { system, messages };
    } finally {
      // 6. 对所有被调过的 contributor cleanup;单个抛错不影响其余(§5.4/§3.2)。
      for (const c of called) {
        if (!c.cleanup) continue;
        try {
          c.cleanup();
        } catch (err) {
          this.#onError(err, 'cleanup');
        }
      }
    }
  }

  /** 把 volatile 键值以扁平 `[Context]\n- key: value` bullet 追加到用户文本(无 XML 标签,§5.4)。 */
  #withVolatile(userText: string, volatile?: ReadonlyArray<readonly [string, string]>): string {
    if (!volatile || volatile.length === 0) return userText;
    const bullets = volatile.map(([k, v]) => `- ${k}: ${v}`).join('\n');
    return `${userText}\n\n[Context]\n${bullets}`;
  }
}
