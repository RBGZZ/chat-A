/**
 * 出站音频 10ms 切片 + wall-clock 配速(承 §4.2 / voice-infra 深读)。
 *
 * 「10ms 切片 + wall-clock 配速」是**播放中途干净打断的物理前提**:把整段 TTS 音频切成
 * 10ms 小片、按真实时钟节流投放,打断时只丢未投放的尾片,已投放的最多多播一片(≤10ms)。
 *
 * 关键工程约束(承注入时钟,**不依赖真实时间**):时钟与定时器经构造注入,测试可用
 * 假时钟确定性推进——这是 §3 可测试性 + §4 延迟工程的交汇点。
 *
 * 字节对齐(承 protocol/pcm.ts 硬约定):
 *   - 16k mono s16le:10ms = 160 样本 = **320 字节/片**;
 *   - 24k mono s16le:10ms = 240 样本 = **480 字节/片**。
 * 这里以**样本数**切片(Int16Array,每样本 2 字节),字节数 = 样本数 × 2。
 */

/** 每片时长(ms):10ms 切片硬约定。 */
export const SLICE_MS = 10;

/**
 * 给定采样率算每 10ms 片的样本数(mono)。
 * 16000→160、24000→240(对齐 pcm.ts:160 样本 = 320 字节)。
 */
export function samplesPerSlice(sampleRate: number, sliceMs: number = SLICE_MS): number {
  return Math.round((sampleRate * sliceMs) / 1000);
}

/** 每 10ms 片的字节数(Int16=2 字节/样本,mono)。16k→320、24k→480。 */
export function bytesPerSlice(sampleRate: number, sliceMs: number = SLICE_MS): number {
  return samplesPerSlice(sampleRate, sliceMs) * 2;
}

/**
 * 纯切片:把整段 Int16 样本切成 10ms 片(末片可能不足整片,原样保留)。
 * 无副作用、不涉时钟——便于单测断言切片边界。
 */
export function sliceAudio(
  samples: Int16Array,
  sampleRate: number,
  sliceMs: number = SLICE_MS,
): Int16Array[] {
  const per = samplesPerSlice(sampleRate, sliceMs);
  if (per <= 0) return samples.length > 0 ? [samples] : [];
  const out: Int16Array[] = [];
  for (let off = 0; off < samples.length; off += per) {
    // subarray 共享底层 buffer(零拷贝);只读消费,骨架阶段够用。
    out.push(samples.subarray(off, Math.min(off + per, samples.length)));
  }
  return out;
}

// ───────────────────────────── 注入式时钟 ─────────────────────────────

/**
 * 配速所需的最小时钟接口(承 §3 可测试性:时间是注入的依赖,不是全局副作用)。
 * 生产用 `systemClock`(performance.now + setTimeout);测试用假时钟确定性推进。
 */
export interface PacerClock {
  /** 当前单调时刻(ms)。 */
  now(): number;
  /** 延后 `ms` 调用 `cb`;返回取消句柄(打断时清未触发的定时器)。 */
  setTimer(ms: number, cb: () => void): () => void;
}

/** 生产时钟:`performance.now()` + `setTimeout`(默认实现)。 */
export const systemClock: PacerClock = {
  now: () => performance.now(),
  setTimer: (ms, cb) => {
    const id = setTimeout(cb, ms);
    return () => clearTimeout(id);
  },
};

export interface AudioPacerOptions {
  /** 采样率(Hz):决定每片样本/字节数(16000/24000)。 */
  readonly sampleRate: number;
  /** 每片投放回调(下游消费:喂帧管线 / 终端)。 */
  readonly onSlice: (slice: Int16Array, index: number) => void;
  /** 全部片投放完毕回调(可选)。 */
  readonly onDone?: () => void;
  /** 注入时钟(默认 `systemClock`;测试传假时钟)。 */
  readonly clock?: PacerClock;
  /** 片时长(ms),默认 10。 */
  readonly sliceMs?: number;
}

/**
 * 音频出站配速器(承 §4.2「10ms 切片 + wall-clock 配速」)。
 *
 * 用法:`start(samples)` 切片并按 wall-clock 逐片投放(片间隔 = sliceMs);
 * `stop()` 干净打断——清未触发定时器、停止后续投放(打断的物理前提)。
 *
 * **不依赖真实时间**:所有时序经注入 `clock` 推进,假时钟下完全确定。
 */
export class AudioPacer {
  readonly #sampleRate: number;
  readonly #onSlice: (slice: Int16Array, index: number) => void;
  readonly #onDone: (() => void) | undefined;
  readonly #clock: PacerClock;
  readonly #sliceMs: number;
  #slices: Int16Array[] = [];
  #index = 0;
  #cancel: (() => void) | undefined;
  #running = false;

  constructor(opts: AudioPacerOptions) {
    this.#sampleRate = opts.sampleRate;
    this.#onSlice = opts.onSlice;
    this.#onDone = opts.onDone;
    this.#clock = opts.clock ?? systemClock;
    this.#sliceMs = opts.sliceMs ?? SLICE_MS;
  }

  /** 是否正在配速投放。 */
  get running(): boolean {
    return this.#running;
  }

  /** 已投放片数(测试观测用)。 */
  get emittedCount(): number {
    return this.#index;
  }

  /**
   * 开始配速:切片 → 第 0 片立即投放(t=0 不等待)→ 其余每隔 sliceMs 一片。
   * 已在跑则先 `stop()` 复位(避免叠加)。
   */
  start(samples: Int16Array): void {
    this.stop();
    this.#slices = sliceAudio(samples, this.#sampleRate, this.#sliceMs);
    this.#index = 0;
    this.#running = true;
    this.#emitNext();
  }

  /** 干净打断:清未触发定时器、停止投放(已投放的不回收)。 */
  stop(): void {
    this.#cancel?.();
    this.#cancel = undefined;
    this.#running = false;
  }

  // 投放当前片,并排程下一片(wall-clock 配速)。
  #emitNext(): void {
    if (!this.#running) return;
    if (this.#index >= this.#slices.length) {
      this.#running = false;
      this.#onDone?.();
      return;
    }
    const slice = this.#slices[this.#index]!;
    const idx = this.#index;
    this.#index += 1;
    this.#onSlice(slice, idx);
    // 排程下一片:wall-clock 配速,间隔 = sliceMs(经注入时钟,确定性可测)。
    this.#cancel = this.#clock.setTimer(this.#sliceMs, () => {
      this.#cancel = undefined;
      this.#emitNext();
    });
  }
}
