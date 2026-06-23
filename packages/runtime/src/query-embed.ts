import type { Embedder } from '@chat-a/providers';

/** query 嵌入结果(承 §5.5 非阻塞):vector=null 表示本轮不用语义(退关键词快路径)。 */
export interface QueryEmbedResult {
  readonly vector: number[] | null;
  readonly latencyMs: number;
  readonly timedOut: boolean;
  readonly cacheHit: boolean;
}

export interface QueryEmbedOptions {
  /** 有界等待预算(ms);默认 120;设 0=只用缓存绝不等(承 §5.7b)。 */
  readonly budgetMs?: number;
  /** LRU 缓存条数;默认 256。 */
  readonly cacheSize?: number;
  /** 注入时钟(测试);默认 Date.now。 */
  readonly now?: () => number;
}

/**
 * 非阻塞 query 嵌入(§5.5/§5.7b):LRU 缓存 + 超时预算 + AbortController;
 * 绝不抛、超时/失败→null(退关键词快路径),后台跑完写缓存供下次命中。
 */
export class QueryEmbedder {
  readonly #embedder: Embedder;
  readonly #budgetMs: number;
  readonly #cacheSize: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, number[]>(); // 插入序即 LRU 序

  constructor(embedder: Embedder, opts?: QueryEmbedOptions) {
    this.#embedder = embedder;
    this.#budgetMs = opts?.budgetMs ?? 120;
    this.#cacheSize = opts?.cacheSize ?? 256;
    this.#now = opts?.now ?? Date.now;
  }

  async embed(text: string): Promise<QueryEmbedResult> {
    const start = this.#now();
    const key = `${this.#embedder.id}::${text}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached); // 触达刷新 LRU
      return { vector: cached, latencyMs: 0, timedOut: false, cacheHit: true };
    }
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        ac.abort();
        resolve('timeout');
      }, this.#budgetMs);
    });
    const run = this.#embedder
      .embed([text], ac.signal)
      .then((vs) => {
        const v = vs[0];
        if (v !== undefined) this.#put(key, v);
        return v ?? null;
      })
      .catch(() => null);
    try {
      const winner = await Promise.race([run, timeout]);
      const latencyMs = this.#now() - start;
      if (winner === 'timeout') return { vector: null, latencyMs, timedOut: true, cacheHit: false };
      return { vector: winner, latencyMs, timedOut: false, cacheHit: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #put(key: string, v: number[]): void {
    this.#cache.set(key, v);
    while (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
