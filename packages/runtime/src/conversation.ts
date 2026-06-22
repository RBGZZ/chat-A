import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { makeBusEvent, type ChatMessage } from '@chat-a/protocol';
import type { LlmProvider } from '@chat-a/providers';
import { buildSystemPrompt } from '@chat-a/cognition';
import { InMemoryMemoryStore, type MemoryRecord, type MemoryStore } from '@chat-a/memory';
import {
  PersonaEngine,
  XIAOXUE_SEED,
  type Appraiser,
  type PersonaSeed,
  type PersonaStore,
} from '@chat-a/persona';
import { getTracer, GENAI, CHAT_A } from '@chat-a/observability';
import type { LightVoiceBus } from './bus';

function toException(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export interface ConversationDeps {
  readonly bus: LightVoiceBus;
  readonly llm: LlmProvider;
  /** 记忆接缝(§3.1);默认进程内实现,配置可换 SQLite(真相源,§5/§8.1)。 */
  readonly memory?: MemoryStore;
  /** 人格种子(§6.2);默认 XIAOXUE。 */
  readonly personaSeed?: PersonaSeed;
  /** 情绪评估接缝(§6.1);默认确定性实现。 */
  readonly appraiser?: Appraiser;
  /** 人格状态持久化(§6.1);默认进程内,配置可换 SQLite KV。 */
  readonly personaStore?: PersonaStore;
  readonly sessionId?: string;
}

/**
 * 单次流式回合(SingleShotStrategy,承 §9 P1)。用户文本 → 情绪步进 + 召回记忆 → LLM 流式回复 → 落库。
 * 回合生命周期(turn:start/end)走 A 层总线;correlationId 经 AsyncLocalStorage 贯穿;
 * span 树 turn→llm(§8.1)。记忆/人格经接缝读写,故障降级不拖垮回合(§3.2)。
 * 后续:Agent loop(工具)、打断、二级人格演化、三层记忆/语义召回。
 */
export class Conversation {
  readonly #bus: LightVoiceBus;
  readonly #llm: LlmProvider;
  readonly #memory: MemoryStore;
  readonly #persona: PersonaEngine;
  readonly #skeleton: string;
  readonly #sessionId: string;
  #turnSeq = 0;

  constructor(deps: ConversationDeps) {
    this.#bus = deps.bus;
    this.#llm = deps.llm;
    this.#memory = deps.memory ?? new InMemoryMemoryStore();
    const seed = deps.personaSeed ?? XIAOXUE_SEED;
    this.#skeleton = buildSystemPrompt(seed);
    this.#persona = new PersonaEngine({
      seed,
      ...(deps.appraiser ? { appraiser: deps.appraiser } : {}),
      ...(deps.personaStore ? { store: deps.personaStore } : {}),
    });
    this.#sessionId = deps.sessionId ?? randomUUID().slice(0, 8);
  }

  /** 组装本轮 system:静态骨架 → 召回记忆块 → 当轮 tone fragment(§6.1)。召回失败走空(§3.2)。 */
  #composeSystem(userText: string, toneFragment: string): string {
    let recalled: readonly MemoryRecord[] = [];
    try {
      recalled = this.#memory.recall(userText);
    } catch {
      recalled = [];
    }
    const parts = [this.#skeleton];
    if (recalled.length > 0) {
      parts.push(`[与当前输入相关的记忆]\n${recalled.map((r) => `- ${r.text}`).join('\n')}`);
    }
    parts.push(toneFragment);
    return parts.join('\n\n');
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
        // 情绪步进(appraise → spring → 持久化),拿到本轮 tone fragment。
        const mood = this.#persona.observe(userText);
        turnSpan.setAttribute('chat_a.emotion', mood.emotion);
        const userMsg: ChatMessage = { role: 'user', content: userText };
        const system = this.#composeSystem(userText, mood.toneFragment);
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
              for await (const token of this.#llm.stream({ system, messages })) {
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
          // 回合收尾落库(不阻塞流式首字)。用户输入暂作最朴素记忆来源(P1,待抽取器替换)。
          const at = Date.now();
          this.#memory.appendMessage({
            sessionId: this.#sessionId,
            turnId,
            role: 'user',
            content: userText,
            createdAtMs: at,
            correlationId,
          });
          this.#memory.appendMessage({
            sessionId: this.#sessionId,
            turnId,
            role: 'assistant',
            content: reply,
            createdAtMs: at,
            correlationId,
          });
          this.#memory.addMemory({ text: userText, kind: 'user_utterance', sourceSession: this.#sessionId, createdAtMs: at });
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
