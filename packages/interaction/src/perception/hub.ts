import { makeBusEvent, type RawPerceptionEvent } from '@chat-a/protocol';
import type { EventPublisher } from '../bus';
import type { PerceptionSource } from './types';
import {
  aggregateWindow,
  type AggregateConfig,
  type AggregateInput,
  DEFAULT_AGGREGATE_CONFIG,
} from './debounce';

/**
 * 把一条 raw 事件描述化为聚合窗草案的钩子(去抖第 3 层前的"描述化"接缝)。
 * 默认实现给出朴素描述;真实源可注入更贴切的描述/置信度。
 */
export type Describer = (raw: RawPerceptionEvent) => Omit<AggregateInput, 'atMs'>;

const defaultDescriber: Describer = (raw) => ({
  kind: `${raw.modality}:${raw.kind}`,
  description: `[${raw.modality}] ${raw.kind}`,
  confidence: 1,
  metadata: raw.value,
});

export interface PerceptionHubOptions {
  /** A 层总线发布器(注入);省略则信号无人接收(standalone 降级)。 */
  readonly publisher?: EventPublisher;
  /** 聚合窗配置(0.3s 默认)。 */
  readonly aggregate?: AggregateConfig;
  /** raw → 草案的描述化钩子。 */
  readonly describe?: Describer;
  /**
   * 调度聚合窗 flush 的定时器(可注入,确定性测试)。返回取消句柄。
   * 默认用 setTimeout;测试注入 fake scheduler 手动驱动。
   */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  /** 当前时钟(ms),可注入。默认 Date.now。 */
  readonly now?: () => number;
  /** 关联 ID 工厂(给每批 signal 打 correlationId);默认取 publisher 的当前值或生成。 */
  readonly correlationId?: () => string;
  /** 源/聚合内部错误回调(可追溯;默认 console.error)。 */
  readonly onError?: (err: unknown, where: string) => void;
}

/**
 * 感知中枢(§12.1 task 1.3):注册/启停多源 → 收集 raw → 0.3s 聚合窗合并 → 经 A 层总线
 * fire `signal:perception`(带 correlationId)。**只发不订阅、只采集不决策**(§12)。
 *
 * 降级(§3.2):任一源 `start`/`stop`/emit 抛错都被 Hub 兜底吞掉并记录,不拖垮其它源与主对话。
 */
export class PerceptionHub {
  readonly #sources = new Map<string, PerceptionSource>();
  readonly #publisher: EventPublisher | undefined;
  readonly #aggCfg: AggregateConfig;
  readonly #describe: Describer;
  readonly #schedule: (fn: () => void, delayMs: number) => () => void;
  readonly #now: () => number;
  readonly #correlationId: (() => string) | undefined;
  readonly #onError: (err: unknown, where: string) => void;

  /** 当前聚合窗内累积的草案。 */
  #pending: AggregateInput[] = [];
  /** 当前未到期的 flush 定时器取消句柄(undefined=无待 flush 窗)。 */
  #flushCancel: (() => void) | undefined;
  #started = false;

  constructor(opts: PerceptionHubOptions = {}) {
    this.#publisher = opts.publisher;
    this.#aggCfg = opts.aggregate ?? DEFAULT_AGGREGATE_CONFIG;
    this.#describe = opts.describe ?? defaultDescriber;
    this.#schedule =
      opts.schedule ??
      ((fn, delayMs) => {
        const t = setTimeout(fn, delayMs);
        return () => clearTimeout(t);
      });
    this.#now = opts.now ?? (() => Date.now());
    this.#correlationId = opts.correlationId;
    this.#onError = opts.onError ?? ((e, w) => console.error(`[perception] ${w}`, e));
  }

  /** 注册一个源(不自动启动;start() 时统一拉起,或单独 startSource)。 */
  register(source: PerceptionSource): this {
    this.#sources.set(source.id, source);
    return this;
  }

  get sourceIds(): readonly string[] {
    return [...this.#sources.keys()];
  }

  /** 启动全部已注册源。任一源启动失败不阻塞其它源(§3.2)。 */
  async start(): Promise<void> {
    this.#started = true;
    for (const source of this.#sources.values()) {
      await this.#startOne(source);
    }
  }

  async #startOne(source: PerceptionSource): Promise<void> {
    try {
      await source.start((raw) => this.#onRaw(raw));
    } catch (err) {
      this.#onError(err, `source ${source.id} start failed`);
    }
  }

  /** 停止全部源并清空待 flush 窗。 */
  async stop(): Promise<void> {
    this.#started = false;
    this.#flushCancel?.();
    this.#flushCancel = undefined;
    this.#pending = [];
    for (const source of this.#sources.values()) {
      try {
        await source.stop();
      } catch (err) {
        this.#onError(err, `source ${source.id} stop failed`);
      }
    }
  }

  /** 探活全部源,返回各源健康快照。 */
  health(): Record<string, ReturnType<PerceptionSource['health']>> {
    const out: Record<string, ReturnType<PerceptionSource['health']>> = {};
    for (const [id, s] of this.#sources) {
      try {
        out[id] = s.health();
      } catch (err) {
        this.#onError(err, `source ${id} health failed`);
        out[id] = { healthy: false, detail: 'health() threw' };
      }
    }
    return out;
  }

  /** 一条 raw 进入聚合窗(去抖第 3 层入口)。停机后忽略。 */
  #onRaw(raw: RawPerceptionEvent): void {
    if (!this.#started) return;
    try {
      const draft = this.#describe(raw);
      this.#pending.push({ ...draft, atMs: raw.atMs });
    } catch (err) {
      this.#onError(err, 'describe failed');
      return;
    }
    // 开窗:窗口内的后续 raw 都并入同一批,窗满统一 flush(合并"七嘴八舌")。
    if (this.#flushCancel === undefined) {
      this.#flushCancel = this.#schedule(() => this.#flush(), this.#aggCfg.windowMs);
    }
  }

  /** 聚合窗到期:合并 pending → 逐条 fire signal。 */
  #flush(): void {
    this.#flushCancel = undefined;
    const batch = this.#pending;
    this.#pending = [];
    if (batch.length === 0) return;
    const nowMs = this.#now();
    let signals;
    try {
      signals = aggregateWindow(batch, nowMs, this.#aggCfg);
    } catch (err) {
      this.#onError(err, 'aggregate failed');
      return;
    }
    for (const sig of signals) {
      this.#publish(sig.kind, sig.description, sig.confidence, sig.metadata);
    }
  }

  #publish(
    kind: string,
    description: string,
    confidence: number,
    metadata: Readonly<Record<string, unknown>> | undefined,
  ): void {
    if (this.#publisher === undefined) return;
    const cid =
      this.#correlationId?.() ??
      this.#publisher.currentCorrelationId?.() ??
      `perception-${this.#now()}`;
    const data = {
      kind,
      description,
      confidence,
      ...(metadata !== undefined ? { metadata } : {}),
    };
    try {
      this.#publisher.emit(makeBusEvent('signal:perception', data, cid));
    } catch (err) {
      this.#onError(err, 'publish signal failed');
    }
  }
}
