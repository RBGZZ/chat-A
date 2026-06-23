import { randomUUID } from 'node:crypto';
import { SpanStatusCode, type Span, type Tracer } from '@opentelemetry/api';
import { makeBusEvent } from '@chat-a/protocol';
import type { LlmProvider, Embedder } from '@chat-a/providers';
import {
  buildSystemPrompt,
  PromptAssembler,
  PersonaSkeletonContributor,
  MemoryRecallContributor,
  ToneContributor,
  StyleDisciplineContributor,
  DissentContributor,
} from '@chat-a/cognition';
import {
  InMemoryMemoryStore,
  NoopMemoryExtractor,
  type MemoryExtractor,
  type MemoryStore,
} from '@chat-a/memory';
import {
  PersonaEngine,
  XIAOXUE_SEED,
  DefaultStanceDetector,
  SelfNotionsManager,
  createKvSelfNotionStore,
  type Appraiser,
  type OceanEvolver,
  type PersonaSeed,
  type PersonaStore,
  type SelfNotionEvolver,
  type StanceDetector,
} from '@chat-a/persona';
import { getTracer, GENAI, CHAT_A, NoopDecisionTraceSink, type DecisionTraceSink } from '@chat-a/observability';
import type { LightVoiceBus } from './bus';
import { QueryEmbedder, type QueryEmbedOptions } from './query-embed';
import { composeSystem, detectStance, finalizeTurn, toException } from './turn-shared';

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
  /** 二级 OCEAN 演化接缝(§6.1);默认不注入 = OCEAN 恒定(opt-in,失败降级)。 */
  readonly oceanEvolver?: OceanEvolver;
  /** 立场强度演化接缝(§7#3);默认不注入 = 立场恒定(opt-in,失败降级)。 */
  readonly selfNotionEvolver?: SelfNotionEvolver;
  /** 回合执行策略接缝(§9 P3 前置);默认 SingleShotStrategy(单趟流式回合)。 */
  readonly strategy?: TurnStrategy;
  readonly sessionId?: string;
  /**
   * 主用户稳定标识(§5.3b / §6.1b 关系亲密度):closeness 读写归属此 person。
   * 默认 `'primary'`,与 memory 配置默认一致;若 memory 用 env 自定义了主用户 ID,
   * 应在此一并传入相同值(保持 closeness 归属一致)。
   */
  readonly primaryPersonId?: string;
  /**
   * Embedder 接缝(§5.7/c2b):提供则启用**语义召回**(query 异步嵌入 + recallHybrid);
   * **缺省 = 不启用 = 与今天纯关键词召回逐字一致**(非阻塞硬约束 §5.5)。
   */
  readonly embedder?: Embedder;
  /** query 嵌入预算/缓存(c2b);缺省用 QueryEmbedder 默认(budget 120ms / cache 256)。 */
  readonly queryEmbed?: QueryEmbedOptions;
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
  /** 立场来源(§7#3):持久化 + opt-in 演化;每轮读 current()、收尾 advance()。 */
  readonly selfNotionsManager: SelfNotionsManager;
  readonly assertiveness: number;
  readonly expressiveness: number;
  readonly extractor: MemoryExtractor;
  readonly extractEnabled: boolean;
  readonly traceSink: DecisionTraceSink;
  /** 主用户标识(§6.1b):closeness 读写归属;回合前读、收尾抬升。 */
  readonly primaryPersonId: string;
  /** 语义召回(c2b,§5.7b):回合前并行嵌入 query;缺省=不启用=关键词快路径。 */
  readonly queryEmbedder?: QueryEmbedder;
  /** Embedder(c2b 写侧):回合收尾后台嵌入新记忆;缺省=不嵌入。 */
  readonly embedder?: Embedder;
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
  /** 会话内回合序号(§7#3 演化轮次,供 selfNotionsManager.advance)。 */
  readonly turn: number;
  /**
   * 协作取消信号(承 §3.2 真打断):由外壳从 `send` 第三形参透传,策略转交底层 LLM 调用
   * (`llm.stream(req, signal)` / `completeWithTools(req, signal)`)。缺省=回合不可取消(等价现状)。
   */
  readonly signal?: AbortSignal;
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
  async run(ctx: TurnContext): Promise<string> {
    const { deps, userText, onToken, turnId, correlationId, turnSpan, turnStartMs, turn, signal } = ctx;
    // 回合前:读关系亲密度(§6.1b,惰性衰减、同步快)+ 当前心情渲染本轮 tone
    // (不改状态;情绪推进/closeness 抬升留到回合后,保首字零额外延迟)。
    const closeness = deps.memory.getCloseness(deps.primaryPersonId);
    const mood = deps.persona.tone(closeness);
    turnSpan.setAttribute('chat_a.emotion', mood.emotion);
    // 语义召回(c2b,§5.5 非阻塞):query 嵌入**异步起跑**,与下面 detectStance 并行重叠;
    // 有界等待(QueryEmbedder 内超时→null 退快路径),绝不内联进同步召回。
    const embedP = deps.queryEmbedder ? deps.queryEmbedder.embed(userText) : null;
    // 分歧检测(§7#3):确定性默认同步极快;LLM 实现会增首字延迟(默认关)。降级见 turn-shared。
    const stance = await detectStance(deps, userText);
    turnSpan.setAttribute('chat_a.stance_notions', stance.notions.length);
    const qe = embedP ? await embedP : null; // 与 stance 并行;超时/失败→vector:null
    // 委托 assembler:system(骨架→记忆→tone→异议)+ messages([...history, userMsg])。
    // 有 queryVector → recallHybrid(关键词+向量);否则关键词快路径(composeSystem 内分流)。
    const { assembled, recalled } = composeSystem(deps, userText, mood.toneFragment, stance, qe?.vector ?? undefined);
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
        // 透传 signal(§3.2 真打断):打断时底层 LLM 流真停;缺省 signal=undefined 等价 stream(req)。
        for await (const token of deps.llm.stream({ system, messages }, signal)) {
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
    // 回合收尾(落库/情绪推进/写记忆/决策trace),与 ToolCalling 共用(turn-shared)。
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
      messages,
      turn,
      ...(qe ? { semantic: qe } : {}),
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
    // 分歧检测(§7#3):默认确定性话题命中;assertiveness 取自种子。
    const stanceDetector = deps.stanceDetector ?? new DefaultStanceDetector();
    // 立场来源(§7#3):持久化(复用 memory 的 KV)+ opt-in 演化;默认 current()==种子(等价当前)。
    const selfNotionsManager = new SelfNotionsManager({
      seedNotions: seed.selfNotions ?? [],
      store: createKvSelfNotionStore(memory),
      ...(deps.selfNotionEvolver ? { evolver: deps.selfNotionEvolver } : {}),
    });
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
      ...(deps.oceanEvolver ? { oceanEvolver: deps.oceanEvolver } : {}),
    });
    // 注入了抽取器 → 用抽取的要点;否则保持 naive "存用户原话"(默认行为不变)。
    const extractEnabled = deps.memoryExtractor !== undefined;
    const extractor = deps.memoryExtractor ?? new NoopMemoryExtractor();
    this.#sessionId = deps.sessionId ?? randomUUID().slice(0, 8);
    // 语义召回(c2b):注入 embedder → 建 QueryEmbedder(非阻塞 query 嵌入);缺省=纯关键词。
    const queryEmbedder = deps.embedder
      ? new QueryEmbedder(deps.embedder, deps.queryEmbed)
      : undefined;
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
      selfNotionsManager,
      assertiveness,
      expressiveness,
      extractor,
      extractEnabled,
      traceSink,
      primaryPersonId: deps.primaryPersonId ?? 'primary',
      ...(queryEmbedder ? { queryEmbedder } : {}),
      ...(deps.embedder ? { embedder: deps.embedder } : {}),
    };
    this.#strategy = deps.strategy ?? new SingleShotStrategy();
  }

  async send(
    userText: string,
    onToken: (token: string) => void,
    /** 协作取消信号(可选,向后兼容):透传至 TurnContext → 策略 → LLM 调用;不传=回合不可取消。 */
    signal?: AbortSignal,
  ): Promise<string> {
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
            turn: this.#turnSeq,
            // 仅在提供时填(exactOptionalPropertyTypes 友好;不传则 ctx.signal 为 undefined)。
            ...(signal ? { signal } : {}),
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
