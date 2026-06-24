import { isSpanContextValid, type Span } from '@opentelemetry/api';
import type { AssembledPrompt, AnchorInput, StanceInput } from '@chat-a/cognition';
import type { MemoryRecord } from '@chat-a/memory';
import type { SelfMemoryRef, SttEmotionLike } from '@chat-a/persona';
import type { DecisionTraceRecalled } from '@chat-a/observability';
import type { TurnDeps } from './conversation';
import type { QueryEmbedResult } from './query-embed';

/**
 * 回合共享逻辑(§3.1 复用,不重复):SingleShotStrategy 与 ToolCallingStrategy 共用的
 * prompt 组装 / 分歧检测 / 记忆写入 / 决策 trace / 回合收尾。两策略只在"LLM 交互"那一段不同,
 * 其余逐字一致 → 工具回合的记忆/人格/trace 与单趟零漂移。
 */

export function toException(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

/** 当轮心情快照(取自 persona.tone()),供收尾落 trace。 */
export interface MoodSnapshot {
  readonly emotion: string;
  readonly pad: { readonly pleasure: number; readonly arousal: number; readonly dominance: number };
  readonly posture: string | undefined;
}

/**
 * 组装本轮 prompt(§5.4):召回(失败降级空)+ assembler;回传 recalled 供 trace。
 * 取数在编排层、assembler 不直接碰 MemoryStore(接缝边界,§3.1)。
 */
export function composeSystem(
  deps: TurnDeps,
  userText: string,
  toneFragment: string,
  stance: StanceInput,
  /** c2b:编排层异步算好的 query 向量;提供则走 recallHybrid(关键词+向量),否则关键词快路径(§5.5)。 */
  queryVector?: number[],
  /** §6.1:上一轮 Guard 判漂移时的待重锚;提供且 drift 时 ReAnchorContributor 注入温和重锚。缺省=不注入。 */
  anchor?: AnchorInput,
): { assembled: AssembledPrompt; recalled: readonly MemoryRecord[] } {
  let recalled: readonly MemoryRecord[] = [];
  try {
    recalled = queryVector !== undefined
      ? deps.memory.recallHybrid(userText, { queryVector })
      : deps.memory.recall(userText);
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
    // 仅在有待重锚时填(默认路径不填 → ReAnchorContributor 返回 null,行为字面不变)。
    ...(anchor ? { anchor } : {}),
  });
  return { assembled, recalled };
}

/**
 * 自我一致性检查(§6.1,companion-coherence-wiring):接了 Guard 时在回复生成后调用。
 * 从本轮召回结果筛 `subject==='agent'` 的核心自我记忆映射为 SelfMemoryRef[](接缝边界 §3.1,
 * persona 不依赖 memory 包),连同 agentName 喂 Guard;drift → 返回 AnchorInput 供**下一轮**重锚。
 * Guard 失败 / 无 Guard → 返回 undefined(不锚定),绝不抛、不阻塞回合(§3.2)。
 */
export async function checkSelfConsistency(
  deps: TurnDeps,
  reply: string,
  recalled: readonly MemoryRecord[],
): Promise<AnchorInput | undefined> {
  const guard = deps.selfConsistencyGuard;
  if (guard === undefined) return undefined;
  try {
    // 复用本轮召回(零额外召回开销,非阻塞 §5.5):取 subject=agent 的核心自我记忆。
    const selfMemories: SelfMemoryRef[] = recalled
      .filter((r) => r.subject === 'agent')
      .map((r) => ({
        text: r.text,
        ...(r.kind !== undefined ? { kind: r.kind } : {}),
        core: r.memoryKind === 'core' || r.pinned === true,
      }));
    const res = await guard.check({ reply, selfMemories, agentName: deps.agentName });
    if (!res.drift) return undefined; // 不漂移:不重锚(下轮清空)。
    return { drift: true, ...(res.anchorText !== undefined ? { anchorText: res.anchorText } : {}) };
  } catch {
    return undefined; // 降级:不锚定,回合继续(§3.2)。
  }
}

/** 本轮分歧检测(§7#3);抛错兜底空命中(assertiveness 仍带上,§3.2 降级)。 */
export async function detectStance(deps: TurnDeps, userText: string): Promise<StanceInput> {
  const assertiveness = deps.assertiveness;
  try {
    // 立场取 manager.current()(反映已演化强度);默认(无 evolver)即种子。
    const selfNotions = deps.selfNotionsManager.current();
    const res = await deps.stanceDetector.detect({ userText, selfNotions, assertiveness });
    return { assertiveness, notions: res.notions.map((n) => n.position) };
  } catch {
    return { assertiveness, notions: [] };
  }
}

/** 回合后写记忆:有抽取器→抽要点(失败跳过);否则 naive 存原话(§3.2 降级)。 */
export async function writeMemories(deps: TurnDeps, userText: string, reply: string, atMs: number): Promise<void> {
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

/**
 * 回合收尾(两策略共用):落 user/assistant 消息 → 情绪推进(容错)→ 写记忆 → 决策 trace。
 * 在取得最终回复后调用(首字之后,不挡流式);各步失败降级不打断回合(§3.2)。
 */
export async function finalizeTurn(
  deps: TurnDeps,
  args: {
    readonly turnId: string;
    readonly correlationId: string;
    readonly turnSpan: Span;
    readonly turnStartMs: number;
    readonly userText: string;
    readonly reply: string;
    readonly recalled: readonly MemoryRecord[];
    readonly mood: MoodSnapshot;
    readonly stance: StanceInput;
    readonly system: string;
    readonly messages: readonly { readonly role: string; readonly content: string }[];
    /** 会话内回合序号(§7#3 立场演化轮次)。 */
    readonly turn: number;
    /** c2b:本轮 query 嵌入结果(供 trace 记语义元数据);缺省=未启用语义。 */
    readonly semantic?: QueryEmbedResult;
    /**
     * §6.1:写回本轮 Guard 结论给外壳(供**下一轮**重锚)。仅接了 Guard 时由外壳注入;
     * drift → 传 AnchorInput,不漂移 → 传 undefined(清空)。缺省 = 不接 Guard(等价现状)。
     */
    readonly setPendingAnchor?: (anchor: AnchorInput | undefined) => void;
    /**
     * §7#5:本轮语音 prosody 情绪;提供则经 `persona.advance(userText, { prosodyEmotion })` 并入 PAD,
     * 并把 `label` 记进决策 trace(可追溯 §8.1)。缺省=无语音情绪=情绪推进与 trace 与现状逐字一致。
     */
    readonly prosodyEmotion?: SttEmotionLike;
  },
): Promise<void> {
  const at = Date.now();
  // §8.1 可追溯:有语音 prosody 情绪则把 label 标进 turn span(经既有 OTel 接缝,纯加法、不改 trace schema)。
  if (args.prosodyEmotion !== undefined) {
    try {
      args.turnSpan.setAttribute('chat_a.prosody_emotion', args.prosodyEmotion.label);
    } catch {
      /* 可观测性绝不打断回合(§3.2) */
    }
  }
  deps.memory.appendMessage({
    sessionId: deps.sessionId,
    turnId: args.turnId,
    role: 'user',
    content: args.userText,
    createdAtMs: at,
    correlationId: args.correlationId,
  });
  deps.memory.appendMessage({
    sessionId: deps.sessionId,
    turnId: args.turnId,
    role: 'assistant',
    content: args.reply,
    createdAtMs: at,
    correlationId: args.correlationId,
  });
  // 情绪推进(影响下一轮);appraiser 内部已降级,这里再兜一层不打断回合(§3.2)。
  // §7#5:有语音 prosody 情绪则并入 PAD(persona 内部按权重合并文本+语音拉力);无则与现状逐字一致。
  try {
    if (args.prosodyEmotion !== undefined) {
      await deps.persona.advance(args.userText, { prosodyEmotion: args.prosodyEmotion });
    } else {
      await deps.persona.advance(args.userText);
    }
  } catch {
    /* 心情本轮不更新,回合继续 */
  }
  // 立场强度演化(§7#3,opt-in;无 evolver = no-op);manager 内部已降级,再兜一层不打断回合。
  try {
    await deps.selfNotionsManager.advance(args.userText, args.turn);
  } catch {
    /* 立场本轮不演化,回合继续 */
  }
  await writeMemories(deps, args.userText, args.reply, at);
  // 关系亲密度抬升(§6.1b):按当轮情绪正向程度(pleasure 正分量)缓升,渐近饱和;
  // 在回复之后、非首字热路径;失败不打断回合(§3.2)。
  try {
    deps.memory.bumpCloseness(deps.primaryPersonId, Math.max(args.mood.pad.pleasure, 0), at);
  } catch {
    /* closeness 本轮不更新,回合继续 */
  }
  // 自我一致性检查(§6.1,companion-coherence-wiring):接了 Guard 时在回复之后判定(首字之后,
  // 不挡流式);drift → 把锚点写回外壳供**下一轮**温和重锚。未接 Guard / 失败 → 不锚定(§3.2)。
  // setPendingAnchor 仅在接了 Guard 时由外壳注入(缺省不调,等价现状)。
  if (args.setPendingAnchor !== undefined) {
    const anchor = await checkSelfConsistency(deps, args.reply, args.recalled);
    args.setPendingAnchor(anchor); // drift→AnchorInput;不漂移/降级→undefined(清空待重锚)。
  }
  // 写侧 embedding(c2b,§5.2/§5.5):回复之后**后台 fire-and-forget**,绝不挡热路径;
  // 取仍缺向量的记忆批量嵌入并写回(失败本轮跳过,§3.2)。仅在启用 embedder 时进行。
  const embedder = deps.embedder;
  if (embedder !== undefined) {
    const pending = deps.memory.memoriesNeedingEmbedding(8);
    if (pending.length > 0) {
      void Promise.allSettled(
        pending.map(async (m) => {
          try {
            const [v] = await embedder.embed([m.text]);
            if (v !== undefined) deps.memory.setEmbedding(m.id, v);
          } catch {
            /* 后台嵌入失败:本轮跳过,下轮再补 */
          }
        }),
      );
    }
  }
  // 决策 trace 收尾落库(§8.1,失败自吞);trace_id/span_id 缝合 OTel。
  try {
    const sc = args.turnSpan.spanContext();
    const recalled: DecisionTraceRecalled[] = args.recalled.map((r) => ({
      text: r.text,
      subject: r.subject,
      hits: r.hits,
      ...(r.kind !== undefined ? { kind: r.kind } : {}),
    }));
    deps.traceSink.record({
      correlationId: args.correlationId,
      ...(isSpanContextValid(sc) ? { traceId: sc.traceId, spanId: sc.spanId } : {}),
      sessionId: deps.sessionId,
      turnId: args.turnId,
      createdAtMs: args.turnStartMs,
      latencyMs: Date.now() - args.turnStartMs,
      userText: args.userText,
      recalled,
      emotion: args.mood.emotion,
      pad: args.mood.pad,
      ...(args.mood.posture !== undefined ? { posture: args.mood.posture } : {}),
      assertiveness: args.stance.assertiveness,
      stanceNotions: args.stance.notions,
      system: args.system,
      messages: args.messages,
      provider: deps.llm.id,
      model: deps.llm.model,
      reply: args.reply,
      ...(args.semantic
        ? {
            semanticUsed: args.semantic.vector !== null,
            embedLatencyMs: args.semantic.latencyMs,
            embedTimedOut: args.semantic.timedOut,
            embedCacheHit: args.semantic.cacheHit,
          }
        : {}),
    });
  } catch {
    /* 决策 trace 写入失败:可观测性绝不打断回合(§3.2) */
  }
}
