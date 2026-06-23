import { randomUUID } from 'node:crypto';
import { SpanStatusCode, isSpanContextValid, type Span, type Tracer } from '@opentelemetry/api';
import { makeBusEvent } from '@chat-a/protocol';
import type { LlmProvider } from '@chat-a/providers';
import {
  buildSystemPrompt,
  PromptAssembler,
  PersonaSkeletonContributor,
  MemoryRecallContributor,
  ToneContributor,
  StyleDisciplineContributor,
  DissentContributor,
  type AssembledPrompt,
  type StanceInput,
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
  DefaultStanceDetector,
  type Appraiser,
  type PersonaSeed,
  type PersonaStore,
  type SelfNotion,
  type StanceDetector,
} from '@chat-a/persona';
import {
  getTracer,
  GENAI,
  CHAT_A,
  NoopDecisionTraceSink,
  type DecisionTraceSink,
  type DecisionTraceRecalled,
} from '@chat-a/observability';
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
  /** 分歧检测接缝(§7#3);默认确定性 DefaultStanceDetector(话题命中)。 */
  readonly stanceDetector?: StanceDetector;
  /** 决策 trace 写入接缝(§8.1);默认 Noop(不写)。回合收尾写,失败不打断回合。 */
  readonly traceSink?: DecisionTraceSink;
  /** 回合执行策略接缝(§9 P3 前置);默认 SingleShotStrategy(单趟流式回合)。 */
  readonly strategy?: TurnStrategy;
  readonly sessionId?: string;
}

/**
 * 回合体所需的只读依赖句柄(§3.1 接缝边界):由 Conversation 构造期装配好后打包传给策略,
 * 使策略不反向依赖 Conversation 实例内部。生命周期/总线/turn span 不在此(归外壳)。
 */
export interface TurnDeps {
  readonly tracer: Tracer;
  readonly llm: LlmProvider;
  readonly memory: MemoryStore;
  readonly persona: PersonaEngine;
  readonly sessionId: string;
  readonly skeleton: string;
  readonly assembler: PromptAssembler;
  readonly stanceDetector: StanceDetector;
  readonly selfNotions: readonly SelfNotion[];
  readonly assertiveness: number;
  readonly expressiveness: number;
  readonly extractor: MemoryExtractor;
  readonly extractEnabled: boolean;
  readonly traceSink: DecisionTraceSink;
}

/**
 * 一个回合的执行上下文(§9 P3 接缝):由 Conversation 外壳在每回合开始时填充,
 * 携带 per-turn 标识(turnId/correlationId)、外壳已开的 turnSpan、起始时间与依赖句柄。
 */
export interface TurnContext {
  readonly userText: string;
  readonly onToken: (token: string) => void;
  readonly turnId: string;
  readonly correlationId: string;
  /** 外壳开启的 turn span;策略可经它设回合级属性(emotion/stance_notions)。 */
  readonly turnSpan: Span;
  /** turn:start 时间戳,latency 基线。 */
  readonly turnStartMs: number;
  readonly deps: TurnDeps;
}

/**
 * 回合执行策略接缝(§9 P3 前置):描述"一个回合体如何执行"。生命周期(turn:start/end)、
 * turn span、correlationId 由 Conversation 外壳负责;策略只跑回合体并返回回复文本。
 * 默认 SingleShotStrategy(单趟流式);后续 Agent loop(工具多步)作为另一策略挂到同一外壳。
 */
export interface TurnStrategy {
  /** 执行一个回合体,返回最终回复文本。不负责 emit turn:start/end、不开 turn span(归外壳)。 */
  run(ctx: TurnContext): Promise<string>;
}

/**
 * 单次流式回合(SingleShotStrategy,承 §9 P1)。用户文本 → 情绪步进 + 召回记忆 → LLM 流式回复 → 落库。
 * 回合体经 TurnContext 取上下文与依赖;span 树 turn→llm(§8.1)中的 llm 子 span 在此开。
 * 记忆/人格经接缝读写,故障降级不拖垮回合(§3.2)。
 * 后续:Agent loop(工具)、打断、二级人格演化、三层记忆/语义召回。
 */
export class SingleShotStrategy implements TurnStrategy {
  /**
   * 组装本轮 prompt(§5.4):构造 PromptContext(骨架/召回/tone/userText/history=snapshot())
   * 委托 assembler 产出 { system, messages }。召回失败走空(§3.2,保留现有降级);
   * 取数在编排层、assembler 不直接碰 MemoryStore(接缝边界,§3.1)。
   */
  #composeSystem(
    deps: TurnDeps,
    userText: string,
    toneFragment: string,
    stance: StanceInput,
  ): { assembled: AssembledPrompt; recalled: readonly MemoryRecord[] } {
    let recalled: readonly MemoryRecord[] = [];
    try {
      recalled = deps.memory.recall(userText);
    } catch {
      recalled = [];
    }
    const assembled = deps.assembler.assemble({
      skeleton: deps.skeleton,
      recalled,
      toneFragment,
      userText,
      history: deps.memory.snapshot(),
      stance,
      expressiveness: deps.expressiveness,
    });
    // 同时回传 recalled 供决策 trace 记录(§8.1);assembler 仍只消费 ctx,不破接缝。
    return { assembled, recalled };
  }

  /**
   * 本轮分歧检测(§7#3):跑 StanceDetector 得命中观点 → 映射为 cognition 侧 StanceInput。
   * 检测抛错兜底空命中(assertiveness 仍带上,基线指令照常据档决定,§3.2 降级)。
   */
  async #detectStance(deps: TurnDeps, userText: string): Promise<StanceInput> {
    const assertiveness = deps.assertiveness;
    try {
      const res = await deps.stanceDetector.detect({
        userText,
        selfNotions: deps.selfNotions,
        assertiveness,
      });
      return { assertiveness, notions: res.notions.map((n) => n.position) };
    } catch {
      return { assertiveness, notions: [] };
    }
  }

  /**
   * 回合收尾写决策 trace(§8.1 可重放真相源)。在取得回复、落记忆后调用(不挡首字);
   * 写入失败自吞,绝不打断回合(§3.2)。traceId/spanId 取本回合 OTel span(无效则省略,缝合用)。
   */
  #recordTrace(
    deps: TurnDeps,
    args: {
      correlationId: string;
      turnId: string;
      spanContext: { traceId: string; spanId: string } | undefined;
      createdAtMs: number;
      latencyMs: number;
      userText: string;
      recalled: readonly MemoryRecord[];
      emotion: string;
      pad: { pleasure: number; arousal: number; dominance: number };
      posture: string | undefined;
      stance: StanceInput;
      system: string;
      messages: readonly { role: string; content: string }[];
      reply: string;
    },
  ): void {
    try {
      const recalled: DecisionTraceRecalled[] = args.recalled.map((r) => ({
        text: r.text,
        subject: r.subject,
        hits: r.hits,
        ...(r.kind !== undefined ? { kind: r.kind } : {}),
      }));
      deps.traceSink.record({
        correlationId: args.correlationId,
        ...(args.spanContext ? { traceId: args.spanContext.traceId, spanId: args.spanContext.spanId } : {}),
        sessionId: deps.sessionId,
        turnId: args.turnId,
        createdAtMs: args.createdAtMs,
        latencyMs: args.latencyMs,
        userText: args.userText,
        recalled,
        emotion: args.emotion,
        pad: args.pad,
        ...(args.posture !== undefined ? { posture: args.posture } : {}),
        assertiveness: args.stance.assertiveness,
        stanceNotions: args.stance.notions,
        system: args.system,
        messages: args.messages,
        provider: deps.llm.id,
        model: deps.llm.model,
        reply: args.reply,
      });
    } catch {
      /* 决策 trace 写入失败:可观测性绝不打断回合(§3.2) */
    }
  }

  /** 回合后写记忆:启用抽取器则写抽取要点(失败跳过);否则 naive 存用户原话(§3.2 降级)。 */
  async #writeMemories(deps: TurnDeps, userText: string, reply: string, atMs: number): Promise<void> {
    if (deps.extractEnabled) {
      try {
        const items = await deps.extractor.extract(userText, reply);
        for (const it of items) deps.memory.addMemory(it);
      } catch {
        /* 抽取失败:跳过本轮抽取,回合不受影响 */
      }
      return;
    }
    deps.memory.addMemory({ text: userText, kind: 'user_utterance', sourceSession: deps.sessionId, createdAtMs: atMs });
  }

  async run(ctx: TurnContext): Promise<string> {
    const { deps, userText, onToken, turnId, correlationId, turnSpan, turnStartMs } = ctx;
    // 回合前:读当前心情渲染本轮 tone(不改状态;情绪推进留到回合后,保首字零额外延迟)。
    const mood = deps.persona.tone();
    turnSpan.setAttribute('chat_a.emotion', mood.emotion);
    // 分歧检测(§7#3):确定性默认同步极快;LLM 实现会增首字延迟(默认关)。降级见 #detectStance。
    const stance = await this.#detectStance(deps, userText);
    turnSpan.setAttribute('chat_a.stance_notions', stance.notions.length);
    // 委托 assembler:system(骨架→记忆→tone→异议)+ messages([...history, userMsg],含 volatile 追加)。
    const { assembled, recalled } = this.#composeSystem(deps, userText, mood.toneFragment, stance);
    const { system, messages } = assembled;
    const reply = await deps.tracer.startActiveSpan('llm', async (llmSpan) => {
      // GenAI 语义约定:id/model 仅供 trace,业务不据此分支(承 Provider 接缝)。
      llmSpan.setAttribute(GENAI.OPERATION_NAME, 'chat');
      llmSpan.setAttribute(GENAI.PROVIDER_NAME, deps.llm.id);
      llmSpan.setAttribute(GENAI.REQUEST_MODEL, deps.llm.model);
      llmSpan.setAttribute(GENAI.CONVERSATION_ID, deps.sessionId);
      llmSpan.setAttribute(GENAI.OUTPUT_TYPE, 'text');
      let acc = '';
      try {
        for await (const token of deps.llm.stream({ system, messages })) {
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
    deps.memory.appendMessage({
      sessionId: deps.sessionId,
      turnId,
      role: 'user',
      content: userText,
      createdAtMs: at,
      correlationId,
    });
    deps.memory.appendMessage({
      sessionId: deps.sessionId,
      turnId,
      role: 'assistant',
      content: reply,
      createdAtMs: at,
      correlationId,
    });
    // 情绪推进(影响下一轮);appraiser 内部已自带降级,这里再兜一层不打断回合(§3.2)。
    try {
      await deps.persona.advance(userText);
    } catch {
      /* 心情本轮不更新,回合继续 */
    }
    // 记忆来源:有抽取器 → 抽要点入库(失败跳过);否则 naive 存用户原话(默认)。
    await this.#writeMemories(deps, userText, reply, at);
    // 决策 trace 收尾落库(§8.1,首字之后,失败不打断回合);trace_id/span_id 缝合 OTel。
    const sc = turnSpan.spanContext();
    this.#recordTrace(deps, {
      correlationId,
      turnId,
      spanContext: isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : undefined,
      createdAtMs: turnStartMs,
      latencyMs: Date.now() - turnStartMs,
      userText,
      recalled,
      emotion: mood.emotion,
      pad: mood.pad,
      posture: mood.posture ?? undefined,
      stance,
      system,
      messages,
      reply,
    });
    return reply;
  }
}

/**
 * 回合外壳(承 §9 P1/P3):负责回合生命周期(turn:start/end)、A 层总线、correlationId
 * (经 AsyncLocalStorage 贯穿)、OTel turn span(§8.1)与依赖装配;把"一个回合具体怎么跑"
 * 委托给注入的 TurnStrategy(默认 SingleShotStrategy)。公开 API 对外稳定:回合范式可经
 * strategy 接缝替换(如后续 Agent loop)而不改外壳。
 */
export class Conversation {
  readonly #bus: LightVoiceBus;
  readonly #strategy: TurnStrategy;
  readonly #deps: TurnDeps;
  readonly #sessionId: string;
  #turnSeq = 0;

  constructor(deps: ConversationDeps) {
    this.#bus = deps.bus;
    const memory = deps.memory ?? new InMemoryMemoryStore();
    const seed = deps.personaSeed ?? XIAOXUE_SEED;
    const skeleton = buildSystemPrompt(seed);
    // 分歧检测(§7#3):默认确定性话题命中;selfNotions/assertiveness 取自种子。
    const stanceDetector = deps.stanceDetector ?? new DefaultStanceDetector();
    const selfNotions = seed.selfNotions ?? [];
    const assertiveness = seed.dials.assertiveness;
    // 风格 steer 强度(§7#4):由 expressiveness 旋钮微调 StyleDisciplineContributor。
    const expressiveness = seed.dials.expressiveness;
    const traceSink = deps.traceSink ?? new NoopDecisionTraceSink();
    // 构造期建好 assembler(注册四个内置 contributor),实例稳定供 KV 复用(§5.4)。
    const assembler = new PromptAssembler([
      new PersonaSkeletonContributor(),
      new MemoryRecallContributor(),
      new ToneContributor(),
      new StyleDisciplineContributor(),
      new DissentContributor(),
    ]);
    const persona = new PersonaEngine({
      seed,
      ...(deps.appraiser ? { appraiser: deps.appraiser } : {}),
      ...(deps.personaStore ? { store: deps.personaStore } : {}),
    });
    // 注入了抽取器 → 用抽取的要点;否则保持 naive "存用户原话"(默认行为不变)。
    const extractEnabled = deps.memoryExtractor !== undefined;
    const extractor = deps.memoryExtractor ?? new NoopMemoryExtractor();
    this.#sessionId = deps.sessionId ?? randomUUID().slice(0, 8);
    // 依赖装配完打包成 TurnDeps(只读句柄),供策略消费而不反向依赖外壳内部(§3.1)。
    this.#deps = {
      tracer: getTracer(),
      llm: deps.llm,
      memory,
      persona,
      sessionId: this.#sessionId,
      skeleton,
      assembler,
      stanceDetector,
      selfNotions,
      assertiveness,
      expressiveness,
      extractor,
      extractEnabled,
      traceSink,
    };
    this.#strategy = deps.strategy ?? new SingleShotStrategy();
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
        const turnStartMs = Date.now();
        this.#bus.emit(makeBusEvent('turn:start', { startedAtMs: turnStartMs }, correlationId));
        try {
          // 委托回合体给策略;生命周期/总线/turn span/correlationId 由外壳负责(对外等价)。
          const reply = await this.#strategy.run({
            userText,
            onToken,
            turnId,
            correlationId,
            turnSpan,
            turnStartMs,
            deps: this.#deps,
          });
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
