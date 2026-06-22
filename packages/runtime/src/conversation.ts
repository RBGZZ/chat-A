import { randomUUID } from 'node:crypto';
import { SpanStatusCode } from '@opentelemetry/api';
import { makeBusEvent } from '@chat-a/protocol';
import type { LlmProvider } from '@chat-a/providers';
import {
  buildSystemPrompt,
  PromptAssembler,
  PersonaSkeletonContributor,
  MemoryRecallContributor,
  ToneContributor,
  type AssembledPrompt,
} from '@chat-a/cognition';
import {
  InMemoryMemoryStore,
  NoopMemoryExtractor,
  type MemoryExtractor,
  type MemoryRecord,
  type MemoryStore,
} from '@chat-a/memory';
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
  /** 记忆抽取接缝;提供则回合后用它抽取要点(替换 naive 存原话),默认不抽取。 */
  readonly memoryExtractor?: MemoryExtractor;
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
  readonly #extractor: MemoryExtractor;
  readonly #extractEnabled: boolean;
  readonly #skeleton: string;
  readonly #assembler: PromptAssembler;
  readonly #sessionId: string;
  #turnSeq = 0;

  constructor(deps: ConversationDeps) {
    this.#bus = deps.bus;
    this.#llm = deps.llm;
    this.#memory = deps.memory ?? new InMemoryMemoryStore();
    const seed = deps.personaSeed ?? XIAOXUE_SEED;
    this.#skeleton = buildSystemPrompt(seed);
    // 构造期建好 assembler(注册三个内置 contributor),实例稳定供 KV 复用(§5.4)。
    this.#assembler = new PromptAssembler([
      new PersonaSkeletonContributor(),
      new MemoryRecallContributor(),
      new ToneContributor(),
    ]);
    this.#persona = new PersonaEngine({
      seed,
      ...(deps.appraiser ? { appraiser: deps.appraiser } : {}),
      ...(deps.personaStore ? { store: deps.personaStore } : {}),
    });
    // 注入了抽取器 → 用抽取的要点;否则保持 naive "存用户原话"(默认行为不变)。
    this.#extractEnabled = deps.memoryExtractor !== undefined;
    this.#extractor = deps.memoryExtractor ?? new NoopMemoryExtractor();
    this.#sessionId = deps.sessionId ?? randomUUID().slice(0, 8);
  }

  /**
   * 组装本轮 prompt(§5.4):构造 PromptContext(骨架/召回/tone/userText/history=snapshot())
   * 委托 assembler 产出 { system, messages }。召回失败走空(§3.2,保留现有降级);
   * 取数在编排层、assembler 不直接碰 MemoryStore(接缝边界,§3.1)。
   */
  #composeSystem(userText: string, toneFragment: string): AssembledPrompt {
    let recalled: readonly MemoryRecord[] = [];
    try {
      recalled = this.#memory.recall(userText);
    } catch {
      recalled = [];
    }
    return this.#assembler.assemble({
      skeleton: this.#skeleton,
      recalled,
      toneFragment,
      userText,
      history: this.#memory.snapshot(),
    });
  }

  /** 回合后写记忆:启用抽取器则写抽取要点(失败跳过);否则 naive 存用户原话(§3.2 降级)。 */
  async #writeMemories(userText: string, reply: string, atMs: number): Promise<void> {
    if (this.#extractEnabled) {
      try {
        const items = await this.#extractor.extract(userText, reply);
        for (const it of items) this.#memory.addMemory(it);
      } catch {
        /* 抽取失败:跳过本轮抽取,回合不受影响 */
      }
      return;
    }
    this.#memory.addMemory({ text: userText, kind: 'user_utterance', sourceSession: this.#sessionId, createdAtMs: atMs });
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
        // 回合前:读当前心情渲染本轮 tone(不改状态;情绪推进留到回合后,保首字零额外延迟)。
        const mood = this.#persona.tone();
        turnSpan.setAttribute('chat_a.emotion', mood.emotion);
        // 委托 assembler:system(骨架→记忆→tone)+ messages([...history, userMsg],含 volatile 追加)。
        const { system, messages } = this.#composeSystem(userText, mood.toneFragment);
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
          // 回合收尾落库(不阻塞流式首字)。
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
          // 情绪推进(影响下一轮);appraiser 内部已自带降级,这里再兜一层不打断回合(§3.2)。
          try {
            await this.#persona.advance(userText);
          } catch {
            /* 心情本轮不更新,回合继续 */
          }
          // 记忆来源:有抽取器 → 抽要点入库(失败跳过);否则 naive 存用户原话(默认)。
          await this.#writeMemories(userText, reply, at);
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
