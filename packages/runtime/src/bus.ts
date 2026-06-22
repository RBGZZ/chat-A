import { AsyncLocalStorage } from 'node:async_hooks';
import type { BusAction, BusEvent } from '@chat-a/protocol';

type SpecificEvent<A extends BusAction> = Extract<BusEvent, { action: A }>;
// 返回类型用 void(而非 void|Promise<void>):void 返回位置允许 handler 返回任意值
// (含 async 的 Promise<void>),对调用方更友好。内部存为 () => unknown 以便检测 Promise。
type Listener<A extends BusAction> = (event: SpecificEvent<A>) => void;
type AnyListener = (event: BusEvent) => void;

interface Subscriber {
  readonly action: BusAction | '*';
  readonly fn: (event: BusEvent) => unknown;
  readonly once: boolean;
}

export interface BusOptions {
  /** history 环形缓冲容量,默认 100。 */
  readonly historyCapacity?: number;
  /** 单 handler 延迟预算(ms),超则告警不杀,默认 50。 */
  readonly handlerBudgetMs?: number;
  readonly onSlowHandler?: (info: { action: string; elapsedMs: number }) => void;
  readonly onHandlerError?: (error: unknown, event: BusEvent) => void;
}

interface TraceContext {
  readonly correlationId: string;
}

// 等同 OTel JS 默认的 AsyncLocalStorageContextManager(§8.1);MVP 先用 node 内置,
// 后续接 @opentelemetry/sdk-node。
const als = new AsyncLocalStorage<TraceContext>();

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) {
      deepFreeze((obj as Record<string, unknown>)[key]);
    }
  }
  return obj;
}

/**
 * A 层事件总线(承 §4.2.2 派发语义):类型化 pub/sub + deepFreeze + 每订阅者隔离 +
 * per-handler 超时告警 + history 环形 + AsyncLocalStorage 传 correlationId。
 * 同步有序分发;async handler fire-and-forget(不 await)+ 捕获 rejection。不设队列。
 */
export class LightVoiceBus {
  readonly #subs = new Set<Subscriber>();
  readonly #history: BusEvent[] = [];
  readonly #historyCap: number;
  readonly #budgetMs: number;
  readonly #onSlow: (info: { action: string; elapsedMs: number }) => void;
  readonly #onError: (error: unknown, event: BusEvent) => void;

  constructor(opts: BusOptions = {}) {
    this.#historyCap = opts.historyCapacity ?? 100;
    this.#budgetMs = opts.handlerBudgetMs ?? 50;
    this.#onSlow =
      opts.onSlowHandler ??
      ((i) => console.warn(`[bus] slow handler for ${i.action}: ${i.elapsedMs.toFixed(1)}ms`));
    this.#onError = opts.onHandlerError ?? ((e) => console.error('[bus] handler error', e));
  }

  on<A extends BusAction>(action: A, fn: Listener<A>): () => void {
    return this.#add({ action, fn: fn as unknown as Subscriber['fn'], once: false });
  }

  once<A extends BusAction>(action: A, fn: Listener<A>): () => void {
    return this.#add({ action, fn: fn as unknown as Subscriber['fn'], once: true });
  }

  /** 全量观察者(§8.1:onAny → SQLite event 日志的钩子)。 */
  onAny(fn: AnyListener): () => void {
    return this.#add({ action: '*', fn, once: false });
  }

  emit(event: BusEvent): void {
    deepFreeze(event);
    this.#history.push(event);
    if (this.#history.length > this.#historyCap) {
      this.#history.splice(0, this.#history.length - this.#historyCap);
    }
    for (const sub of [...this.#subs]) {
      if (sub.action !== '*' && sub.action !== event.action) continue;
      if (sub.once) this.#subs.delete(sub);
      this.#invoke(sub, event);
    }
  }

  history(): readonly BusEvent[] {
    return [...this.#history];
  }

  /** 在关联上下文内执行(AsyncLocalStorage 跨 async 传播 correlationId)。 */
  runWithCorrelation<T>(correlationId: string, fn: () => T): T {
    return als.run({ correlationId }, fn);
  }

  currentCorrelationId(): string | undefined {
    return als.getStore()?.correlationId;
  }

  #add(sub: Subscriber): () => void {
    this.#subs.add(sub);
    return () => {
      this.#subs.delete(sub);
    };
  }

  #invoke(sub: Subscriber, event: BusEvent): void {
    const start = performance.now();
    try {
      const result = sub.fn(event);
      if (result instanceof Promise) {
        result.then(
          () => this.#checkBudget(start, event),
          (err: unknown) => this.#onError(err, event),
        );
      } else {
        this.#checkBudget(start, event);
      }
    } catch (err) {
      this.#onError(err, event);
    }
  }

  #checkBudget(start: number, event: BusEvent): void {
    const elapsed = performance.now() - start;
    if (elapsed > this.#budgetMs) {
      this.#onSlow({ action: event.action, elapsedMs: elapsed });
    }
  }
}
