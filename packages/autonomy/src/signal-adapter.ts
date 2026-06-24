/**
 * signal:* 适配器(承 §3.1 经总线解耦 + 与 external-interaction-mvp 的事件契约对齐)。
 *
 * autonomy 经 A 层总线**消费** `signal:*`(感知/计时产出),映射为内核 `AutonomyEvent` 入队;
 * 「是否据信号主动开口」由决策 LLM 判(本包),「signal 的产生」由 external-interaction-mvp 负责。
 *
 * **契约对齐**(与 external-interaction-mvp/specs/perception):`signal:*` 事件携带
 * `{description, metadata, confidence}`。本 change 在 interaction change 未合并前**用占位类型 + 适配**:
 * 不强依赖 protocol 里登记 `signal:*`(避免与并行 change 在 `BusEventMap` 抢改),
 * 而是从总线 `onAny` 拿到的事件中**鸭子类型**识别 `action` 以 `signal:` 开头者;
 * 合并后若 protocol 正式登记 `signal:*`,本适配器可平滑收敛到强类型(取并集,不破坏)。
 *
 * 优先级映射(承 §7 / types EventPriority):
 *   - `signal:user:*`(用户语音/在场)→ URGENT(软反转,用户永远最先);
 *   - 其余感知/计时(`signal:temporal:*` / `signal:system:*` / `signal:env:*` 等)→ PERCEPTION;
 *   - 未知 → PERCEPTION(保守:当感知处理,不当紧急也不当自言自语)。
 */
import type { PriorityEventQueue } from './priority-queue';
import type { AutonomyEvent, Clock, EventPriority } from './types';

/**
 * 占位 signal 事件形状(鸭子类型):只认 `action`(以 `signal:` 开头)+ 可选 `data`。
 * 与 protocol `BusEvent`(Envelope)同构子集——合并后可直接收敛到 `Extract<BusEvent, {action:`signal:${string}`}>`。
 */
export interface SignalLike {
  readonly action: string;
  readonly data?: {
    readonly description?: string;
    readonly metadata?: unknown;
    readonly confidence?: number;
  };
}

/** 鸭子类型守卫:是否一个 `signal:*` 事件。 */
export function isSignalEvent(e: unknown): e is SignalLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    typeof (e as { action?: unknown }).action === 'string' &&
    (e as { action: string }).action.startsWith('signal:')
  );
}

/** 据 signal action 前缀映射到内核三级优先级(单一权威,承 §7)。 */
export function signalPriority(action: string): EventPriority {
  if (action.startsWith('signal:user:')) return 'URGENT';
  return 'PERCEPTION';
}

/**
 * 把一个 `signal:*` 事件映射为内核 `AutonomyEvent`(非 synthetic、带注入时钟时刻)。
 * `payload` 透传原 data(内核不解读;决策层 gather 时可读 description/metadata)。
 */
export function signalToEvent(signal: SignalLike, clock: Clock): AutonomyEvent {
  return {
    kind: signal.action,
    priority: signalPriority(signal.action),
    synthetic: false,
    atMs: clock.now(),
    ...(signal.data !== undefined ? { payload: signal.data } : {}),
  };
}

/**
 * 把从总线收到的任意事件(经 onAny)适配入队:非 signal:* 忽略;signal:* 映射入队。
 * 返回是否入队(true=已入队一个感知事件)。
 */
export function ingestBusEventAsSignal(
  event: unknown,
  queue: PriorityEventQueue,
  clock: Clock,
): boolean {
  if (!isSignalEvent(event)) return false;
  queue.enqueue(signalToEvent(event, clock));
  return true;
}
