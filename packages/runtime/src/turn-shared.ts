import { isSpanContextValid, type Span } from '@opentelemetry/api';
import type { AssembledPrompt, StanceInput } from '@chat-a/cognition';
import type { MemoryRecord } from '@chat-a/memory';
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
  });
  return { assembled, recalled };
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
  },
): Promise<void> {
  const at = Date.now();
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
  try {
    await deps.persona.advance(args.userText);
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
