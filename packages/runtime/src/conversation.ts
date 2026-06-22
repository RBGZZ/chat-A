import { randomUUID } from 'node:crypto';
import { makeBusEvent, type ChatMessage } from '@chat-a/protocol';
import type { LlmProvider } from '@chat-a/providers';
import { ConversationMemory, buildSystemPrompt, type Persona } from '@chat-a/cognition';
import type { LightVoiceBus } from './bus';

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
    return this.#bus.runWithCorrelation(correlationId, async () => {
      this.#bus.emit(makeBusEvent('turn:start', { startedAtMs: Date.now() }, correlationId));
      const userMsg: ChatMessage = { role: 'user', content: userText };
      const messages: ChatMessage[] = [...this.#memory.snapshot(), userMsg];
      let reply = '';
      try {
        for await (const token of this.#llm.stream({ system: this.#system, messages })) {
          reply += token;
          onToken(token);
        }
      } catch (err) {
        this.#bus.emit(makeBusEvent('turn:end', { reason: 'error', atMs: Date.now() }, correlationId));
        throw err;
      }
      this.#memory.add(userMsg);
      this.#memory.add({ role: 'assistant', content: reply });
      this.#bus.emit(makeBusEvent('turn:end', { reason: 'completed', atMs: Date.now() }, correlationId));
      return reply;
    });
  }
}
