import { makeRawEvent } from '@chat-a/protocol';
import type { PerceptionSource, RawEmit, SourceHealth } from '../types';

/** 一条系统通知的最小负载(来源/标题/正文;均可选)。 */
export interface SystemNotification {
  readonly source?: string;
  readonly title?: string;
  readonly body?: string;
  /** 通知发生时刻(ms);省略则 push 时取当前时钟。 */
  readonly atMs?: number;
}

export interface SystemNotificationOptions {
  readonly now?: () => number;
}

/**
 * 内置感知源:**系统通知源**(§12.1 task 1.4)。
 * MVP 不绑定具体 OS 通知 API(跨平台/嵌入式差异大),而是暴露 `push()` 注入点——
 * 上层(或平台适配)把一条通知喂进来,源 emit `raw:system:notification`(结构化,不描述化)。
 * 这样测试可直接 push、真机由平台适配桥接,接缝清晰(§3.2 行为即配置)。
 */
export interface SystemNotificationSource extends PerceptionSource {
  /** 注入一条系统通知(start 后才会真正 emit;未 start 则丢弃)。 */
  push(notification: SystemNotification): void;
}

export function createSystemNotificationSource(
  opts: SystemNotificationOptions = {},
): SystemNotificationSource {
  const now = opts.now ?? (() => Date.now());
  let emit: RawEmit | undefined;
  let lastEmitMs: number | undefined;
  let running = false;

  return {
    id: 'system.notification',
    modality: 'system',
    start(e: RawEmit): void {
      running = true;
      emit = e;
    },
    stop(): void {
      running = false;
      emit = undefined;
    },
    health(): SourceHealth {
      return {
        healthy: running,
        ...(lastEmitMs !== undefined ? { lastEmitMs } : {}),
      };
    },
    push(notification: SystemNotification): void {
      if (!running || emit === undefined) return;
      const atMs = notification.atMs ?? now();
      lastEmitMs = atMs;
      emit(
        makeRawEvent('system', 'notification', atMs, {
          ...(notification.source !== undefined ? { source: notification.source } : {}),
          ...(notification.title !== undefined ? { title: notification.title } : {}),
          ...(notification.body !== undefined ? { body: notification.body } : {}),
        }),
      );
    },
  };
}
