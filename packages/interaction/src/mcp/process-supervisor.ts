/**
 * 受监督的能力单元(§12.3,task 4.x)。把"一个能力进程/外设"抽象为可启停/探活的单元——
 * 真机里 = 拉起 MCP server 子进程 + 连 client;测试里 = mock。这样监督逻辑可不依赖真实进程测试。
 */
export interface SupervisedUnit {
  readonly id: string;
  /** 是否核心能力:核心强制监督(崩溃必重启);可选可降级不阻塞启动(task 4.2)。 */
  readonly core: boolean;
  /** 拉起单元(连接/启动)。失败抛错。 */
  start(): Promise<void>;
  /** 停止单元(LIFO 关闭时调用)。应尽力而为不抛。 */
  stop(): Promise<void>;
  /** 探活:false = 已崩溃需重启。 */
  health(): boolean | Promise<boolean>;
}

export interface BackoffConfig {
  /** 初始退避(ms)。默认 200。 */
  readonly initialMs: number;
  /** 退避上限(ms)。默认 30000。 */
  readonly maxMs: number;
  /** 倍率。默认 2。 */
  readonly factor: number;
  /** jitter 比例(0..1):实际延迟 = base ± base*jitter*rand。默认 0.2。 */
  readonly jitter: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  initialMs: 200,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

/**
 * 第 n 次重试(n 从 0 起)的退避延迟(**纯函数**,rand 注入 → 可测)。
 * base = min(maxMs, initialMs * factor^n);叠加 ±jitter。
 */
export function computeBackoff(
  attempt: number,
  cfg: BackoffConfig,
  rand: () => number = Math.random,
): number {
  const base = Math.min(cfg.maxMs, cfg.initialMs * Math.pow(cfg.factor, attempt));
  const delta = base * cfg.jitter * (rand() * 2 - 1);
  return Math.max(0, Math.round(base + delta));
}

export interface ProcessSupervisorOptions {
  readonly backoff?: BackoffConfig;
  /** 定时器(可注入,确定性测试)。返回取消句柄。默认 setTimeout。 */
  readonly schedule?: (fn: () => void, delayMs: number) => () => void;
  /** jitter 随机源(可注入)。默认 Math.random。 */
  readonly rand?: () => number;
  /** 日志/可追溯回调。默认 console。 */
  readonly onEvent?: (e: SupervisorEvent) => void;
}

export type SupervisorEvent =
  | { readonly type: 'started'; readonly id: string }
  | { readonly type: 'start_failed'; readonly id: string; readonly core: boolean; readonly error: string }
  | { readonly type: 'crashed'; readonly id: string }
  | { readonly type: 'restart_scheduled'; readonly id: string; readonly attempt: number; readonly delayMs: number }
  | { readonly type: 'restarted'; readonly id: string }
  | { readonly type: 'stopped'; readonly id: string };

interface UnitState {
  readonly unit: SupervisedUnit;
  attempt: number;
  cancelRestart: (() => void) | undefined;
  running: boolean;
}

/**
 * 进程监督(§12.3,task 4.1/4.2/4.3):
 * - 拉起单元;**可选能力启动失败不阻塞**整体启动(降级,§3.2);核心启动失败照样进监督重试。
 * - 崩溃自愈:指数退避 + jitter 重启(`reportCrash`/周期探活触发)。
 * - 关闭:**LIFO** 优雅顺序(后启动的先关)。
 */
export class ProcessSupervisor {
  readonly #units: UnitState[] = []; // 保持启动顺序,关闭时逆序。
  readonly #byId = new Map<string, UnitState>();
  readonly #backoff: BackoffConfig;
  readonly #schedule: (fn: () => void, delayMs: number) => () => void;
  readonly #rand: () => number;
  readonly #onEvent: (e: SupervisorEvent) => void;

  constructor(opts: ProcessSupervisorOptions = {}) {
    this.#backoff = opts.backoff ?? DEFAULT_BACKOFF;
    this.#schedule =
      opts.schedule ??
      ((fn, ms) => {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      });
    this.#rand = opts.rand ?? Math.random;
    this.#onEvent = opts.onEvent ?? (() => {});
  }

  add(unit: SupervisedUnit): this {
    const state: UnitState = { unit, attempt: 0, cancelRestart: undefined, running: false };
    this.#units.push(state);
    this.#byId.set(unit.id, state);
    return this;
  }

  /**
   * 启动全部单元。可选能力启动失败 → 记录降级、**不抛、不阻塞**其它单元(task 4.2);
   * 核心能力启动失败 → 记录并安排退避重启(不阻塞启动流程,自愈在后台进行)。
   */
  async start(): Promise<void> {
    for (const state of this.#units) {
      await this.#tryStart(state);
    }
  }

  async #tryStart(state: UnitState): Promise<void> {
    try {
      await state.unit.start();
      state.running = true;
      state.attempt = 0;
      this.#onEvent({ type: 'started', id: state.unit.id });
    } catch (err) {
      state.running = false;
      const error = err instanceof Error ? err.message : String(err);
      this.#onEvent({ type: 'start_failed', id: state.unit.id, core: state.unit.core, error });
      // 可选能力:降级,不阻塞(但仍尝试自愈,便于稍后恢复);核心:必自愈。
      this.#scheduleRestart(state);
    }
  }

  /** 外部上报某单元崩溃(如 client onclose / 探活失败)→ 触发退避重启。 */
  reportCrash(id: string): void {
    const state = this.#byId.get(id);
    if (state === undefined) return;
    if (!state.running && state.cancelRestart !== undefined) return; // 已在重启队列。
    state.running = false;
    this.#onEvent({ type: 'crashed', id });
    this.#scheduleRestart(state);
  }

  /** 周期探活:对所有 running 单元调 health(),不健康者触发重启。 */
  async pollHealth(): Promise<void> {
    for (const state of this.#units) {
      if (!state.running) continue;
      let ok = false;
      try {
        ok = await state.unit.health();
      } catch {
        ok = false;
      }
      if (!ok) this.reportCrash(state.unit.id);
    }
  }

  #scheduleRestart(state: UnitState): void {
    if (state.cancelRestart !== undefined) return; // 已排队。
    const delayMs = computeBackoff(state.attempt, this.#backoff, this.#rand);
    this.#onEvent({ type: 'restart_scheduled', id: state.unit.id, attempt: state.attempt, delayMs });
    state.cancelRestart = this.#schedule(() => {
      state.cancelRestart = undefined;
      state.attempt += 1;
      void this.#restart(state);
    }, delayMs);
  }

  async #restart(state: UnitState): Promise<void> {
    try {
      await state.unit.start();
      state.running = true;
      state.attempt = 0;
      this.#onEvent({ type: 'restarted', id: state.unit.id });
    } catch {
      // 仍失败 → 继续退避(attempt 已自增,延迟更长)。
      this.#scheduleRestart(state);
    }
  }

  /** 探活快照。 */
  isRunning(id: string): boolean {
    return this.#byId.get(id)?.running ?? false;
  }

  /** LIFO 优雅关闭(task 4.3):后启动的先停;取消所有待重启。 */
  async stopAll(): Promise<void> {
    for (let i = this.#units.length - 1; i >= 0; i -= 1) {
      const state = this.#units[i]!;
      state.cancelRestart?.();
      state.cancelRestart = undefined;
      if (state.running) {
        try {
          await state.unit.stop();
        } catch {
          // 尽力而为。
        }
        state.running = false;
      }
      this.#onEvent({ type: 'stopped', id: state.unit.id });
    }
  }
}
