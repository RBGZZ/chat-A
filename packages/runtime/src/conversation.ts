import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { makeBusEvent, type ChatMessage } from '@chat-a/protocol';
import type { LlmProvider } from '@chat-a/providers';
import { ConversationMemory, buildSystemPrompt, type Persona } from '@chat-a/cognition';
import { getTracer, GENAI, CHAT_A } from '@chat-a/observability';
import type { LightVoiceBus } from './bus';

function toException(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export interface ConversationDeps {
  readonly bus: LightVoiceBus;
  readonly llm: LlmProvider;
  readonly memory?: ConversationMemory;
  readonly persona?: Persona;
  readonly sessionId?: string;
}

/**
 * 单次流式回合(SingleShotStrategy,承 §9 P1)。用户文本 → LLM 流式回复 → 落历史。
 * 回合生命周期(turn:start/end)走 A 层总线;correlationId 经 AsyncLocalStorage 贯穿。
 * 后续:Agent loop(工具)、打断、情感/人格 fragment、三层记忆召回。
 */
export class Conversation {
  readonly #bus: LightVoiceBus;
  readonly #llm: LlmProvider;
  readonly #memory: ConversationMemory;
  readonly #system: string;
  readonly #sessionId: string;
  #turnSeq = 0;

  constructor(deps: ConversationDeps) {
    this.#bus = deps.bus;
    this.#llm = deps.llm;
    this.#memory = deps.memory ?? new ConversationMemory();
    this.#system = buildSystemPrompt(deps.persona);
    this.#sessionId = deps.sessionId ?? randomUUID().slice(0, 8);
  }

  async send(userText: string, onToken: (token: string) => void): Promise<string> {
    const turnId = `t${++this.#turnSeq}`;
    const correlationId = `${this.#sessionId}/${turnId}/0`;
    const tracer = getTracer();
    // 关联上下文(correlationId,ALS)+ OTel span 树(turn → llm,§8.1)同时贯穿本回合。
    return this.#bus.runWithCorrelation(correlationId, () =>
      tracer.startActiveSpan('turn', async (turnSpan) => {
        turnSpan.setAttribute(CHAT_A.CORRELATION_ID, correlationId);
        turnSpan.setAttribute(CHAT_A.SESSION_ID, this.#sessionId);
        turnSpan.setAttribute(CHAT_A.TURN_ID, turnId);
        this.#bus.emit(makeBusEvent('turn:start', { startedAtMs: Date.now() }, correlationId));
        const userMsg: ChatMessage = { role: 'user', content: userText };
        const messages: ChatMessage[] = [...this.#memory.snapshot(), userMsg];
        try {
          const reply = await tracer.startActiveSpan('llm', async (llmSpan) => {
            // GenAI 语义约定:id/model 仅供 trace,业务不据此分支(承 Provider 接缝)。
            llmSpan.setAttribute(GENAI.OPERATION_NAME, 'chat');
            llmSpan.setAttribute(GENAI.PROVIDER_NAME, this.#llm.id);
            llmSpan.setAttribute(GENAI.REQUEST_MODEL, this.#llm.model);
            llmSpan.setAttribute(GENAI.CONVERSATION_ID, this.#sessionId);
            llmSpan.setAttribute(GENAI.OUTPUT_TYPE, 'text');
            let acc = '';
            try {
              for await (const token of this.#llm.stream({ system: this.#system, messages })) {
                acc += token;
                onToken(token);
              }
              llmSpan.setStatus({ code: SpanStatusCode.OK });
              return acc;
            } catch (err) {
              llmSpan.recordException(toException(err));
              llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: toException(err).message });
              throw err;
            } finally {
              llmSpan.end();
            }
          });
          this.#memory.add(userMsg);
          this.#memory.add({ role: 'assistant', content: reply });
          this.#bus.emit(makeBusEvent('turn:end', { reason: 'completed', atMs: Date.now() }, correlationId));
          turnSpan.setStatus({ code: SpanStatusCode.OK });
          return reply;
        } catch (err) {
          this.#bus.emit(makeBusEvent('turn:end', { reason: 'error', atMs: Date.now() }, correlationId));
          turnSpan.recordException(toException(err));
          turnSpan.setStatus({ code: SpanStatusCode.ERROR, message: toException(err).message });
          throw err;
        } finally {
          turnSpan.end();
        }
      }),
    );
  }
}
