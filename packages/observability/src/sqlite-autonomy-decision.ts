/**
 * autonomy 决策 trace → SQLite 落库适配(承 §8.1 autonomy 决策可追溯)。
 *
 * autonomy 包 standalone(§3.1):只定义单向写入接缝 `AutonomyDecisionSink { record(trace) }`,
 * **不直接 import observability/SQLite**。本适配在接线层(observability 侧)把一条 autonomy 决策
 * (silent/speak/idle + reason + 输入摘要)映射成回合层 `DecisionTrace`,复用既有 `decision_traces`
 * 表与 {@link SqliteDecisionTraceSink} 句柄——二者**同 correlationId 缝合**,共一张表、共一份重放真相源。
 *
 * 为保持 observability standalone(不反向依赖 autonomy),这里用**结构化本地类型**描述 autonomy
 * 决策形状(与 `@chat-a/autonomy` 的 `AutonomyDecisionTrace` 同构子集),实现同名 `record` 契约;
 * autonomy 侧把本实例当 `AutonomyDecisionSink` 注入即可(鸭子类型兼容)。
 *
 * 纪律(§8.1 / §3.2):`record` MUST 不抛以致中断决策回路(底层 sink 内部已自吞);不在用户首字热路径。
 */
import type { DecisionTrace, DecisionTraceSink } from './decision-trace';

/** autonomy 一次主动决策的三态裁决(与 `@chat-a/autonomy` 同构;本包不反向依赖 autonomy)。 */
export type AutonomyDecisionKindLike = 'silent' | 'speak' | 'idle';

/** autonomy 决策输入摘要(与 `@chat-a/autonomy` `AutonomyDecisionInput` 同构子集)。 */
export interface AutonomyDecisionInputLike {
  readonly candidates: readonly string[];
  readonly context?: string;
}

/** 一条 autonomy 决策 trace(与 `@chat-a/autonomy` `AutonomyDecisionTrace` 同构子集)。 */
export interface AutonomyDecisionTraceLike {
  readonly correlationId?: string;
  readonly skillId: string;
  readonly atMs: number;
  readonly decision: AutonomyDecisionKindLike;
  readonly reason: string;
  readonly input: AutonomyDecisionInputLike;
  readonly text?: string;
  readonly fellBack?: boolean;
}

/** autonomy 决策写入接缝(单向:决策回路 → sink;与 `@chat-a/autonomy` 的 `AutonomyDecisionSink` 同形)。 */
export interface AutonomyDecisionSinkLike {
  record(trace: AutonomyDecisionTraceLike): void;
}

export interface SqliteAutonomyDecisionSinkOptions {
  /** 底层回合 trace sink(通常为 {@link SqliteDecisionTraceSink};共用同一张 decision_traces 表)。 */
  readonly sink: DecisionTraceSink;
  /** 落库失败回调(默认 console.error);降级时记录而非抛出(§3.2)。 */
  readonly onError?: (err: unknown, op: string) => void;
}

/**
 * 把一条 autonomy 决策映射成回合层 `DecisionTrace`(autonomy 决策亦是「她为何开口/沉默」):
 * - `provider='autonomy'`、`model=skillId`:落库后可凭此区分 autonomy 行与回合行(同表共存)。
 * - `userText` 留空(autonomy 非用户驱动);`reply` = speak 时拟说文案(silent/idle 空)。
 * - `recalled/emotion/...` 取无害缺省(autonomy 决策无这些维度;NULL/空保持 schema 完整)。
 * - `messages` 落候选 + context 摘要(供重建「她这一 tick 为何这样判」)。
 */
function toDecisionTrace(t: AutonomyDecisionTraceLike): DecisionTrace {
  const messages: { readonly role: string; readonly content: string }[] = [
    { role: 'system', content: `autonomy 决策(skill=${t.skillId}): ${t.decision} — ${t.reason}` },
  ];
  t.input.candidates.forEach((c, i) => messages.push({ role: 'assistant', content: `候选${i + 1}: ${c}` }));
  if (t.input.context !== undefined && t.input.context.trim().length > 0) {
    messages.push({ role: 'user', content: `上下文: ${t.input.context}` });
  }
  return {
    correlationId: t.correlationId ?? `autonomy/${t.skillId}/${t.atMs}`,
    sessionId: 'autonomy',
    turnId: `${t.skillId}/${t.atMs}`,
    createdAtMs: t.atMs,
    latencyMs: 0,
    userText: '',
    recalled: [],
    emotion: t.decision,
    assertiveness: 0,
    stanceNotions: [],
    system: t.reason,
    messages,
    provider: 'autonomy',
    model: t.skillId,
    reply: t.text ?? '',
  };
}

/**
 * autonomy 决策 SQLite sink:把 autonomy 决策落进既有 decision_traces 表(同 correlationId 缝合)。
 * 实现 `AutonomyDecisionSinkLike`(与 autonomy 的 `AutonomyDecisionSink` 鸭子类型兼容)。
 * `record` 不抛(底层 sink 已自吞;本层映射异常亦经 onError 降级,§3.2)。
 */
export class SqliteAutonomyDecisionSink implements AutonomyDecisionSinkLike {
  readonly #sink: DecisionTraceSink;
  readonly #onError: (err: unknown, op: string) => void;

  constructor(opts: SqliteAutonomyDecisionSinkOptions) {
    this.#sink = opts.sink;
    this.#onError = opts.onError ?? ((err, op) => console.error(`[autonomy-decision] ${op} 失败`, err));
  }

  record(trace: AutonomyDecisionTraceLike): void {
    try {
      this.#sink.record(toDecisionTrace(trace));
    } catch (err) {
      // §8.1/§3.2:autonomy 决策落库绝不打断决策回路。
      this.#onError(err, 'record');
    }
  }
}
