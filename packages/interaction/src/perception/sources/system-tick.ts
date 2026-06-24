import { makeRawEvent } from '@chat-a/protocol';
import type { PerceptionSource, RawEmit, SourceHealth } from '../types';

export interface SystemTickOptions {
  /** 心跳周期(ms)。默认 60000(1 分钟)。 */
  readonly periodMs?: number;
  /** 当前时钟(ms),可注入(确定性测试)。默认 Date.now。 */
  readonly now?: () => number;
  /**
   * 定时器(可注入,确定性测试)。接收周期回调,返回取消句柄。
   * 默认用 setInterval;测试注入 fake 手动驱动 tick。
   */
  readonly schedule?: (fn: () => void, periodMs: number) => () => void;
}

/**
 * 内置感知源:**系统时钟心跳 `system.tick`**(§12.1 task 1.4)。
 * 按周期 emit `raw:temporal:tick`,供主动性/作息感知消费(经总线,不直接调 cognition)。
 * clock 与定时器均可注入 → 确定性测试。
 */
export function createSystemTickSource(opts: SystemTickOptions = {}): PerceptionSource {
  const periodMs = opts.periodMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const schedule =
    opts.schedule ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });

  let cancel: (() => void) | undefined;
  let lastEmitMs: number | undefined;
  let running = false;

  return {
    id: 'system.tick',
    modality: 'temporal',
    start(emit: RawEmit): void {
      if (running) return;
      running = true;
      cancel = schedule(() => {
        const atMs = now();
        lastEmitMs = atMs;
        emit(makeRawEvent('temporal', 'tick', atMs, { periodMs }));
      }, periodMs);
    },
    stop(): void {
      running = false;
      cancel?.();
      cancel = undefined;
    },
    health(): SourceHealth {
      return {
        healthy: running,
        ...(lastEmitMs !== undefined ? { lastEmitMs } : {}),
      };
    },
  };
}
