/**
 * no-action 预算节流(确定性内核,承 §7 / neuro-ecosystem-findings §5)。
 *
 * "有内心独白但不刷屏/不空转"的干净旋钮:
 * - 一轮处理**无产出动作** → 还有预算就扣 1 并合成一个 `LOWEST` "再想一次"事件入队
 *   (让引擎下轮再尝试);预算耗尽就停止合成(进入 idle,不空转)。
 * - 外部信号(如用户开口)→ **重置预算** + **丢弃队列中所有合成的自言自语**
 *   (`synthetic && LOWEST`)。
 *
 * 上限来自 config(`maxNoActionRetries`,默认 3),无 magic number(§3.2)。
 * 注入式时钟给合成事件打 `atMs`(确定性 + 可追溯)。
 */
import type { AutonomyConfig } from './config';
import type { PriorityEventQueue } from './priority-queue';
import { RECONSIDER_EVENT_KIND, type AutonomyEvent, type Clock } from './types';

/** 预算可变状态(单一持有者:autonomy 引擎/调度回路)。 */
export interface BudgetState {
  /** 剩余可"再想一次"的次数。 */
  remaining: number;
}

/** 按配置新建预算状态(满额)。 */
export function createBudgetState(config: Pick<AutonomyConfig, 'maxNoActionRetries'>): BudgetState {
  return { remaining: config.maxNoActionRetries };
}

/** 合成事件判定(单一权威):no-action 预算产生的"再想一次"自言自语。 */
export function isReconsiderEvent(event: AutonomyEvent): boolean {
  return event.synthetic && event.priority === 'LOWEST' && event.kind === RECONSIDER_EVENT_KIND;
}

/**
 * 一轮无产出时调用:还有预算就扣 1 + 合成 `LOWEST` "再想一次"事件入队,返回 `true`;
 * 预算耗尽则不合成、返回 `false`(引擎据此进入 idle,不空转)。
 */
export function consumeOnNoAction(
  state: BudgetState,
  queue: PriorityEventQueue,
  clock: Clock,
): boolean {
  if (state.remaining <= 0) return false;
  state.remaining -= 1;
  queue.enqueue({
    kind: RECONSIDER_EVENT_KIND,
    priority: 'LOWEST',
    synthetic: true,
    atMs: clock.now(),
  });
  return true;
}

/**
 * 外部信号重置预算:复位到上限 + 丢弃队列中所有合成的"再想一次"事件,返回被丢弃数量。
 * 用于"用户开口重置预算并丢弃排队的自言自语"(§7)。
 */
export function resetBudget(
  state: BudgetState,
  queue: PriorityEventQueue,
  config: Pick<AutonomyConfig, 'maxNoActionRetries'>,
): number {
  state.remaining = config.maxNoActionRetries;
  return queue.dropWhere(isReconsiderEvent);
}
