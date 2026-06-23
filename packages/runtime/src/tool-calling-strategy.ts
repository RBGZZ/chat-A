import { SpanStatusCode } from '@opentelemetry/api';
import type { ChatMessage } from '@chat-a/protocol';
import { GENAI } from '@chat-a/observability';
import type { ActionRegistry } from '@chat-a/interaction';
import type { TurnContext, TurnStrategy } from './conversation';
import { SingleShotStrategy } from './conversation';
import { composeSystem, detectStance, finalizeTurn, toException } from './turn-shared';

/** 工具循环默认最大轮数(防死循环,外置)。 */
export const DEFAULT_MAX_TOOL_ITERS = 5;

export interface ToolCallingStrategyOptions {
  /** 本地动作注册表(§12.2)。 */
  readonly registry: ActionRegistry;
  /** 无工具能力时的降级策略(默认 SingleShotStrategy)。 */
  readonly fallback?: TurnStrategy;
  /** 工具循环最大轮数(默认 DEFAULT_MAX_TOOL_ITERS)。 */
  readonly maxIters?: number;
}

/**
 * Agent loop 回合策略(§3.3 模型侧 + §12.2 行动侧):组装 system → 工具循环
 * (completeWithTools;tool_use → registry.execute → 回灌 tool_result → 续,直到文本回复或达上限)
 * → 最终文本 emit。回合收尾(记忆/人格/trace)与 SingleShot 共用 turn-shared(零漂移)。
 * 无工具能力(supportsTools≠true / 无 completeWithTools / 空注册表)→ 降级回 fallback(§3.2)。
 * MVP 非流式中间轮:最终文本一次性 onToken;流式工具通道留后续。
 */
export class ToolCallingStrategy implements TurnStrategy {
  readonly #registry: ActionRegistry;
  readonly #fallback: TurnStrategy;
  readonly #maxIters: number;

  constructor(opts: ToolCallingStrategyOptions) {
    this.#registry = opts.registry;
    this.#fallback = opts.fallback ?? new SingleShotStrategy();
    this.#maxIters = opts.maxIters ?? DEFAULT_MAX_TOOL_ITERS;
  }

  async run(ctx: TurnContext): Promise<string> {
    const { deps, userText, onToken, turnId, correlationId, turnSpan, turnStartMs, turn } = ctx;
    const tools = this.#registry.toolDefs();
    // 降级:Provider 不支持工具 / 未实现 completeWithTools / 空注册表 → 走单趟(§3.2)。
    if (deps.llm.supportsTools !== true || typeof deps.llm.completeWithTools !== 'function' || tools.length === 0) {
      return this.#fallback.run(ctx);
    }
    const completeWithTools = deps.llm.completeWithTools.bind(deps.llm);

    const closeness = deps.memory.getCloseness(deps.primaryPersonId);
    const mood = deps.persona.tone(closeness);
    turnSpan.setAttribute('chat_a.emotion', mood.emotion);
    // 语义召回(c2b,§5.5 非阻塞):query 嵌入异步起跑,与 detectStance 并行重叠。
    const embedP = deps.queryEmbedder ? deps.queryEmbedder.embed(userText) : null;
    const stance = await detectStance(deps, userText);
    turnSpan.setAttribute('chat_a.stance_notions', stance.notions.length);
    const qe = embedP ? await embedP : null;
    const { assembled, recalled } = composeSystem(deps, userText, mood.toneFragment, stance, qe?.vector ?? undefined);
    const { system } = assembled;
    // 工作消息随工具往返增长(初始 = assembler 产出的 [...history, userMsg])。
    const working: ChatMessage[] = [...assembled.messages];

    const reply = await deps.tracer.startActiveSpan('llm', async (llmSpan) => {
      llmSpan.setAttribute(GENAI.OPERATION_NAME, 'chat');
      llmSpan.setAttribute(GENAI.PROVIDER_NAME, deps.llm.id);
      llmSpan.setAttribute(GENAI.REQUEST_MODEL, deps.llm.model);
      llmSpan.setAttribute(GENAI.CONVERSATION_ID, deps.sessionId);
      llmSpan.setAttribute(GENAI.OUTPUT_TYPE, 'text');
      let finalText = '';
      let iters = 0;
      try {
        for (; iters < this.#maxIters; iters++) {
          const resp = await completeWithTools({ system, messages: working, tools });
          finalText = resp.text;
          if (resp.stopReason !== 'tool_use' || resp.toolCalls.length === 0) break;
          // 回灌:assistant(本轮 tool_use)+ tool(执行结果);execute 容错不抛(§3.2)。
          working.push({ role: 'assistant', content: resp.text, toolCalls: resp.toolCalls });
          const results = await Promise.all(resp.toolCalls.map((c) => this.#registry.execute(c)));
          working.push({ role: 'tool', content: '', toolResults: results });
        }
        llmSpan.setAttribute('chat_a.tool_iters', iters);
        llmSpan.setStatus({ code: SpanStatusCode.OK });
        return finalText;
      } catch (err) {
        llmSpan.recordException(toException(err));
        llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: toException(err).message });
        throw err;
      } finally {
        llmSpan.end();
      }
    });

    // MVP:最终文本一次性输出(流式工具通道留后续)。
    if (reply.length > 0) onToken(reply);
    await finalizeTurn(deps, {
      turnId,
      correlationId,
      turnSpan,
      turnStartMs,
      userText,
      reply,
      recalled,
      mood: { emotion: mood.emotion, pad: mood.pad, posture: mood.posture ?? undefined },
      stance,
      system,
      messages: working.map((m) => ({ role: m.role, content: m.content })),
      turn,
      ...(qe ? { semantic: qe } : {}),
    });
    return reply;
  }
}
