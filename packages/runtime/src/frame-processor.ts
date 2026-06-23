/**
 * B 层 Pipecat 式帧管线处理器(承 §4.2 / §4.2.1,**仅骨架,不接回合**)。
 *
 * 范式(§4.2 双队列双任务):
 *   - `SystemFrame`(及运行期打断信令)——**插队、立即处理、不受打断**(快道)。
 *   - `DataFrame`/`ControlFrame` —— **入序队列、顺序处理**;打断时清空(`Uninterruptible` 保活)。
 *
 * 这里只搭"帧如何在单个 processor 内分流/排队/打断、processor 如何串链、出站音频如何配速"
 * 的骨架,**不接 Conversation/回合循环**(端到端组装是后续串行步)。protocol 包不动:
 * `InterruptionFrame` 在 protocol 的 `FramePayloadMap` 里没有载荷(它本就不是高频载荷帧,
 * 而是调度信令),故在 runtime 层定义为**运行期信令帧**,与 protocol `Frame` 组成 `RuntimeFrame`。
 */
import {
  type Frame,
  type SystemFrame,
  isUninterruptible,
} from '@chat-a/protocol';

// ───────────────────────────── 运行期打断信令帧 ─────────────────────────────

/**
 * 打断信令帧(承 §4.2「`InterruptionFrame`(SystemFrame 之一)」):
 * 走 system 快道(`kind:'system'`),**不进 Data/Control 队列**;processor 收到即
 * **广播下游 + 清空自身 Data/Control 队列**(`Uninterruptible` 帧不丢)。
 *
 * 之所以在 runtime 层而非 protocol 定义:protocol `FramePayloadMap` 只登记**高频载荷帧**
 * (audio/stt/llm/tts),打断是**调度信令**无载荷,放进载荷映射会污染 A/B 分层契约。
 * 用独立判别值 `type:'interruption'`(不在 `FrameType` 内),与 protocol `Frame` 物理隔离。
 */
export interface InterruptionFrame {
  readonly kind: 'system';
  readonly type: 'interruption';
  /** 打断原因(可选,便于追溯;省略键即未注明,exactOptional 安全)。 */
  readonly reason?: string;
}

/** 造打断信令帧(`reason` 省略 = 未注明;条件展开,绝不显式赋 undefined)。 */
export function makeInterruptionFrame(reason?: string): InterruptionFrame {
  return reason === undefined
    ? { kind: 'system', type: 'interruption' }
    : { kind: 'system', type: 'interruption', reason };
}

/** 守卫:是否打断信令帧。 */
export function isInterruptionFrame(frame: RuntimeFrame): frame is InterruptionFrame {
  return frame.kind === 'system' && frame.type === 'interruption';
}

/**
 * runtime 帧管线内流动的全集:protocol 高频载荷帧 + 运行期打断信令帧。
 * 二者判别字段不冲突(`type` 空间不交集),编译期可穷尽判别。
 */
export type RuntimeFrame = Frame | InterruptionFrame;

/** 守卫:是否走 system 快道(protocol SystemFrame 或运行期打断信令)。 */
export function isSystemFrame(frame: RuntimeFrame): frame is SystemFrame | InterruptionFrame {
  return frame.kind === 'system';
}

/**
 * 守卫:打断时是否保活(承 §4.2 `Uninterruptible` mixin)。
 * system 帧本就走快道不入队、不被清,亦视为保活;data/control 看 `uninterruptible` 标记。
 */
export function survivesInterruption(frame: RuntimeFrame): boolean {
  if (isSystemFrame(frame)) return true;
  return isUninterruptible(frame);
}

// ───────────────────────────── FrameProcessor ─────────────────────────────

/** 下游投递回调:processor 产出帧喂给下一个 processor(串链时由 pipeline 注入)。 */
export type FrameSink = (frame: RuntimeFrame) => void;

export interface FrameProcessorOptions {
  /**
   * 处理一帧的业务逻辑(骨架默认:原样透传到下游)。
   * 同步或异步均可;Data/Control 帧串行 await,保证顺序;System 帧亦经此处理但**插队即时**。
   */
  readonly onFrame?: (frame: RuntimeFrame, push: FrameSink) => void | Promise<void>;
  /** 收到打断信令时的钩子(广播/清队列之外的额外副作用,如 abort 三件套占位)。 */
  readonly onInterruption?: (frame: InterruptionFrame) => void;
  /** handler 抛错回调(隔离单帧错误,不拖垮队列);默认打日志。 */
  readonly onError?: (error: unknown, frame: RuntimeFrame) => void;
}

/**
 * 单个 B 层帧处理器(承 §4.2 双队列双任务)。
 *
 * - `process(frame)`:统一入口,按 `kind` 分流——
 *     · system(含打断)→ **不入队,立即处理**(快道;打断额外触发广播 + 清队列);
 *     · data/control   → **入序队列**,由后台泵 `#pump` 顺序、串行处理。
 * - **打断**:`InterruptionFrame` → 广播给下游 + 清空 Data/Control 队列(`Uninterruptible` 保活)。
 * - 下游:`setSink` 注入(pipeline 串链用);默认无下游则产出被丢弃。
 *
 * 注:这是**骨架**,不接回合;真实的 STT/LLM/TTS processor 后续以 `onFrame` 注入。
 */
export class FrameProcessor {
  /** Data/Control 顺序队列(高频载荷 + 控制信令;打断时按保活规则筛剩)。 */
  readonly #queue: RuntimeFrame[] = [];
  /** 后台泵是否在跑(单消费者,保证串行顺序;借鉴 AIRI 单消费者语义)。 */
  #pumping = false;
  #sink: FrameSink | undefined;
  readonly #onFrame: (frame: RuntimeFrame, push: FrameSink) => void | Promise<void>;
  readonly #onInterruption: ((frame: InterruptionFrame) => void) | undefined;
  readonly #onError: (error: unknown, frame: RuntimeFrame) => void;

  constructor(opts: FrameProcessorOptions = {}) {
    // 默认 onFrame = 原样透传(骨架:链路先通,业务后注入)。
    this.#onFrame = opts.onFrame ?? ((frame, push) => push(frame));
    this.#onInterruption = opts.onInterruption;
    this.#onError =
      opts.onError ??
      ((e) => console.error('[frame-processor] frame handler error', e));
  }

  /** 注入下游投递口(pipeline 串链时调用;未注入则产出丢弃)。 */
  setSink(sink: FrameSink): void {
    this.#sink = sink;
  }

  /**
   * 帧入口:按调度态分流(§4.2 双队列双任务的「分流」一半)。
   * - system / 打断:走快道,**不排队**;
   * - data / control:入序队列,后台泵顺序处理。
   */
  process(frame: RuntimeFrame): void {
    if (isSystemFrame(frame)) {
      this.#handleSystem(frame);
      return;
    }
    this.#queue.push(frame);
    void this.#startPump();
  }

  /** 当前队列深度(测试/背压观测用)。 */
  get queueLength(): number {
    return this.#queue.length;
  }

  // ── system 快道(插队、立即处理、不受打断)──
  #handleSystem(frame: SystemFrame | InterruptionFrame): void {
    if (isInterruptionFrame(frame)) {
      this.#interrupt(frame);
      return;
    }
    // 普通 SystemFrame:立即处理(不入队、不受打断)。
    // **同步快道**:onFrame 同步返回则同步产出(先于排队 Data);返回 Promise 才挂尾捕获错误。
    this.#dispatchSync(frame);
  }

  // 同步处理:onFrame 同步返回即同步产出;若返回 Promise 则挂尾捕获(不阻塞快道)。
  #dispatchSync(frame: RuntimeFrame): void {
    try {
      const r = this.#onFrame(frame, (f) => this.#push(f));
      if (r instanceof Promise) r.catch((err: unknown) => this.#onError(err, frame));
    } catch (err) {
      this.#onError(err, frame);
    }
  }

  // ── 打断:广播下游 + 清空 Data/Control 队列(Uninterruptible 保活)──
  #interrupt(frame: InterruptionFrame): void {
    // 队列 reset:仅保留打断也送达的帧(如结束信令、函数结果)。
    const survivors = this.#queue.filter((f) => survivesInterruption(f));
    this.#queue.length = 0;
    this.#queue.push(...survivors);
    // 钩子(abort 三件套等占位)。
    this.#onInterruption?.(frame);
    // 双向广播:打断信令本身透传给下游 processor(链上每个都清各自队列)。
    this.#push(frame);
  }

  // ── 后台泵:单消费者串行处理 Data/Control(保证顺序)──
  async #startPump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        const frame = this.#queue.shift()!;
        await this.#dispatch(frame);
      }
    } finally {
      this.#pumping = false;
    }
  }

  // ── 处理单帧(隔离错误,不拖垮队列)──
  async #dispatch(frame: RuntimeFrame): Promise<void> {
    try {
      await this.#onFrame(frame, (f) => this.#push(f));
    } catch (err) {
      this.#onError(err, frame);
    }
  }

  // ── 投递下游(无下游则丢弃)──
  #push(frame: RuntimeFrame): void {
    this.#sink?.(frame);
  }
}

// ───────────────────────────── FramePipeline ─────────────────────────────

/**
 * 把多个 `FrameProcessor` 串成链(承 §4.2「processor 串成链,帧依次流过」)。
 * 上游 processor 的产出经 `setSink` 喂给下游;`push(frame)` 从链首灌入。
 * 链尾的产出经可选 `tail` 收口(端到端组装时接终端/总线;骨架默认丢弃)。
 */
export class FramePipeline {
  readonly #processors: readonly FrameProcessor[];

  constructor(processors: readonly FrameProcessor[], tail?: FrameSink) {
    this.#processors = processors;
    // 串链:processor[i] 的 sink = processor[i+1].process;链尾 = tail(或丢弃)。
    for (let i = 0; i < processors.length; i++) {
      const next = processors[i + 1];
      const downstream: FrameSink = next
        ? (frame) => next.process(frame)
        : tail ?? (() => {});
      processors[i]!.setSink(downstream);
    }
  }

  /** 从链首灌入一帧(打断信令也走这里,逐 processor 广播 + 各自清队列)。 */
  push(frame: RuntimeFrame): void {
    const head = this.#processors[0];
    if (head) head.process(frame);
  }

  /** 链上 processor 数(观测用)。 */
  get length(): number {
    return this.#processors.length;
  }
}
