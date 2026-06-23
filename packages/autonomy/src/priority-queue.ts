/**
 * 单消费者优先级事件队列(确定性内核,承 §7 / §4.2)。
 *
 * - 出队取**当前最高优先级**;**同优先级 FIFO**(用单调入队序号 `seq` 决定,确定性)。
 * - **不用 `setInterval` 驱动**:认知由"事件入队 + 注入 tick"推动,测试可完全确定地推进
 *   (避开 Neuro `Signals` 全局可变状态,§4.2 ⚠️)。
 * - 空出队返回 `undefined`(不抛错,优雅降级 §3.2)。
 *
 * 实现说明:本切片量级小(autonomy 事件低频),用线性扫描选最高优先级 + 最小 seq,
 * O(n) 出队足够且**完全确定**;不引入堆/第三方依赖(standalone)。
 */
import { PRIORITY_RANK, type AutonomyEvent } from './types';

/** 队列内部条目:事件 + 单调入队序号(同级 FIFO 的确定性依据)。 */
interface QueueEntry {
  readonly event: AutonomyEvent;
  readonly seq: number;
}

export class PriorityEventQueue {
  #entries: QueueEntry[] = [];
  /** 单调递增入队序号:杜绝依赖数组下标(被移除元素会扰乱下标)。 */
  #nextSeq = 0;

  /** 当前队列长度。 */
  get size(): number {
    return this.#entries.length;
  }

  /** 入队一个事件(O(1) 追加;选择最高优先级在出队时做)。 */
  enqueue(event: AutonomyEvent): void {
    this.#entries.push({ event, seq: this.#nextSeq++ });
  }

  /**
   * 出队当前最高优先级、同级最早入队的事件;空队列返回 `undefined`。
   * 选择规则(单一权威):先比 `PRIORITY_RANK[priority]` 取大,平手取 `seq` 小(更早)。
   */
  dequeue(): AutonomyEvent | undefined {
    if (this.#entries.length === 0) return undefined;
    let bestIdx = 0;
    let best = this.#entries[0]!;
    for (let i = 1; i < this.#entries.length; i++) {
      const cur = this.#entries[i]!;
      if (isHigher(cur, best)) {
        best = cur;
        bestIdx = i;
      }
    }
    this.#entries.splice(bestIdx, 1);
    return best.event;
  }

  /** 只看不取:返回下一个将出队的事件(同 `dequeue` 选择规则),空则 `undefined`。 */
  peek(): AutonomyEvent | undefined {
    if (this.#entries.length === 0) return undefined;
    let best = this.#entries[0]!;
    for (let i = 1; i < this.#entries.length; i++) {
      const cur = this.#entries[i]!;
      if (isHigher(cur, best)) best = cur;
    }
    return best.event;
  }

  /**
   * 丢弃满足谓词的所有事件,返回被丢弃数量(保持其余事件相对顺序/seq 不变)。
   * 供 no-action 预算重置时"丢弃排队的自言自语"用(§7)。
   */
  dropWhere(predicate: (event: AutonomyEvent) => boolean): number {
    const before = this.#entries.length;
    this.#entries = this.#entries.filter((e) => !predicate(e.event));
    return before - this.#entries.length;
  }

  /** 当前所有事件(出队序的快照,只读;便于测试断言/追溯)。 */
  toSortedArray(): readonly AutonomyEvent[] {
    return [...this.#entries]
      .sort((a, b) => {
        const r = PRIORITY_RANK[b.event.priority] - PRIORITY_RANK[a.event.priority];
        return r !== 0 ? r : a.seq - b.seq;
      })
      .map((e) => e.event);
  }
}

/** `a` 是否比 `b` 更应先出队:优先级高在先,同级则 seq 小(更早)在先。 */
function isHigher(a: QueueEntry, b: QueueEntry): boolean {
  const ra = PRIORITY_RANK[a.event.priority];
  const rb = PRIORITY_RANK[b.event.priority];
  if (ra !== rb) return ra > rb;
  return a.seq < b.seq;
}
