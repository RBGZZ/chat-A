import { makeBusEvent, type ToolCall, type ToolResult } from '@chat-a/protocol';
import type { EventPublisher } from './bus';
import type { ActionRegistry } from './registry';

export interface TaskExecutorOptions {
  /** A 层总线发布器(注入);省略则不发事件(standalone 降级)。 */
  readonly publisher?: EventPublisher;
  /** 时钟,可注入(correlationId 兜底用)。默认 Date.now。 */
  readonly now?: () => number;
}

/** 一次执行的结果(含回灌下回合 context 的可读结果)。 */
export interface ExecOutcome {
  readonly result: ToolResult;
  /** 是否被取消(打断回滚)。 */
  readonly cancelled: boolean;
}

/**
 * 任务执行器(§12.2,task 5.x):复用既有 `ActionRegistry` 执行动作,并经 §4.2 A 层总线发
 * `action:started` → 执行 → `action:completed|failed`(带 correlationId),与对话回合**异步耦合**——
 * 结果(`ToolResult.content`)即下回合 context。
 *
 * - **单飞行**(task 5.2):同名动作并发时,第二个被拒绝(返回 isError 结果,不抢占)。
 * - **取消**(打断回滚,承 §4 AbortSignal):外部 signal abort → 终止等待、发 `action:failed{cancelled}`,
 *   不回灌半执行脏结果。
 *
 * **只执行不决策**(§12):是否发起动作由 cognition/模型决定;此处只忠实执行 + 广播。
 */
export class TaskExecutor {
  readonly #registry: ActionRegistry;
  readonly #publisher: EventPublisher | undefined;
  readonly #now: () => number;
  /** 在飞动作:name → AbortController(单飞行 + 取消)。 */
  readonly #inflight = new Map<string, AbortController>();

  constructor(registry: ActionRegistry, opts: TaskExecutorOptions = {}) {
    this.#registry = registry;
    this.#publisher = opts.publisher;
    this.#now = opts.now ?? (() => Date.now());
  }

  /** 当前是否有同名动作在飞。 */
  isInflight(name: string): boolean {
    return this.#inflight.has(name);
  }

  /**
   * 执行一个工具调用。外部可传 AbortSignal(打断回滚)。
   * 返回 ToolResult(对齐 toolCallId)+ 是否被取消。全程不抛(承 ActionRegistry 容错语义)。
   */
  async execute(call: ToolCall, signal?: AbortSignal): Promise<ExecOutcome> {
    // 单飞行:同名已在飞 → 拒绝(不抢占、不排队,MVP 取拒绝策略)。
    if (this.#inflight.has(call.name)) {
      const result: ToolResult = {
        toolCallId: call.id,
        content: `动作 ${call.name} 正在执行中,已拒绝重复发起(单飞行)`,
        isError: true,
      };
      this.#emitFailed(call, '单飞行拒绝:同名动作在飞', false);
      return { result, cancelled: false };
    }

    const controller = new AbortController();
    this.#inflight.set(call.name, controller);
    // 透传外部打断:外部 signal abort → 本动作 abort。
    const onExternalAbort = (): void => controller.abort();
    if (signal !== undefined) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    this.#emitStarted(call);

    try {
      // 与"取消"竞速:动作执行 vs abort。取消优先回滚,不等动作完成。
      const result = await this.#raceWithAbort(call, controller.signal);
      if (controller.signal.aborted) {
        const cancelledResult: ToolResult = {
          toolCallId: call.id,
          content: `动作 ${call.name} 已被打断取消`,
          isError: true,
        };
        this.#emitFailed(call, '打断取消', true);
        return { result: cancelledResult, cancelled: true };
      }
      if (result.isError === true) {
        this.#emitFailed(call, result.content, false);
      } else {
        this.#emitCompleted(call, result.content);
      }
      return { result, cancelled: false };
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onExternalAbort);
      this.#inflight.delete(call.name);
    }
  }

  /** 取消指定在飞动作(打断)。 */
  cancel(name: string): void {
    this.#inflight.get(name)?.abort();
  }

  /** 取消全部在飞动作(全局打断)。 */
  cancelAll(): void {
    for (const c of this.#inflight.values()) c.abort();
  }

  /** 动作执行与 abort 竞速:abort 先到则立刻返回(回滚语义=不采纳动作结果)。 */
  async #raceWithAbort(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const exec = this.#registry.execute(call);
    if (signal.aborted) {
      return { toolCallId: call.id, content: '已取消', isError: true };
    }
    return new Promise<ToolResult>((resolve) => {
      const onAbort = (): void => {
        // 不 await exec——回滚即"不采纳其结果"。ActionRegistry.execute 不抛,后台自然了结。
        resolve({ toolCallId: call.id, content: '已取消', isError: true });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      void exec.then((r) => {
        signal.removeEventListener('abort', onAbort);
        resolve(r);
      });
    });
  }

  #correlationId(): string {
    return this.#publisher?.currentCorrelationId?.() ?? `action-${this.#now()}`;
  }

  #emitStarted(call: ToolCall): void {
    if (this.#publisher === undefined) return;
    try {
      this.#publisher.emit(
        makeBusEvent('action:started', { name: call.name, toolCallId: call.id }, this.#correlationId()),
      );
    } catch {
      // 总线发布失败不拖垮执行(§3.2)。
    }
  }

  #emitCompleted(call: ToolCall, content: string): void {
    if (this.#publisher === undefined) return;
    try {
      this.#publisher.emit(
        makeBusEvent(
          'action:completed',
          { name: call.name, toolCallId: call.id, content },
          this.#correlationId(),
        ),
      );
    } catch {
      // 同上。
    }
  }

  #emitFailed(call: ToolCall, reason: string, cancelled: boolean): void {
    if (this.#publisher === undefined) return;
    const data = cancelled
      ? { name: call.name, toolCallId: call.id, reason, cancelled: true }
      : { name: call.name, toolCallId: call.id, reason };
    try {
      this.#publisher.emit(makeBusEvent('action:failed', data, this.#correlationId()));
    } catch {
      // 同上。
    }
  }
}
