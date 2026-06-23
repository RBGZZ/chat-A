import { describe, expect, it } from 'vitest';
import { PriorityEventQueue } from '../src/priority-queue';
import type { AutonomyEvent, EventPriority } from '../src/types';

/** 构造一个测试事件(确定性,atMs 由参数给)。 */
function ev(kind: string, priority: EventPriority, atMs = 0, synthetic = false): AutonomyEvent {
  return { kind, priority, synthetic, atMs };
}

describe('PriorityEventQueue(单消费者优先级队列,§7)', () => {
  it('高优先级先于低优先级出队', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('low', 'LOWEST'));
    q.enqueue(ev('urgent', 'URGENT'));
    q.enqueue(ev('perc', 'PERCEPTION'));

    expect(q.dequeue()?.kind).toBe('urgent');
    expect(q.dequeue()?.kind).toBe('perc');
    expect(q.dequeue()?.kind).toBe('low');
    expect(q.size).toBe(0);
  });

  it('同优先级按入队顺序 FIFO', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('A', 'PERCEPTION'));
    q.enqueue(ev('B', 'PERCEPTION'));
    q.enqueue(ev('C', 'PERCEPTION'));

    expect(q.dequeue()?.kind).toBe('A');
    expect(q.dequeue()?.kind).toBe('B');
    expect(q.dequeue()?.kind).toBe('C');
  });

  it('混合:高优先级插队但同级仍 FIFO(golden 出队序)', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('p1', 'PERCEPTION'));
    q.enqueue(ev('l1', 'LOWEST'));
    q.enqueue(ev('u1', 'URGENT'));
    q.enqueue(ev('p2', 'PERCEPTION'));
    q.enqueue(ev('u2', 'URGENT'));
    q.enqueue(ev('l2', 'LOWEST'));

    const order: string[] = [];
    for (let drained = q.dequeue(); drained; drained = q.dequeue()) order.push(drained.kind);
    // URGENT(入队序 u1,u2)→ PERCEPTION(p1,p2)→ LOWEST(l1,l2)
    expect(order).toEqual(['u1', 'u2', 'p1', 'p2', 'l1', 'l2']);
  });

  it('空队列出队返回 undefined,不抛错', () => {
    const q = new PriorityEventQueue();
    expect(q.dequeue()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  it('peek 不移除元素', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('u', 'URGENT'));
    expect(q.peek()?.kind).toBe('u');
    expect(q.size).toBe(1);
    expect(q.dequeue()?.kind).toBe('u');
  });

  it('dropWhere 丢弃满足谓词的事件,返回数量,余者保持出队序', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('keep1', 'PERCEPTION'));
    q.enqueue(ev('synth1', 'LOWEST', 0, true));
    q.enqueue(ev('keep2', 'URGENT'));
    q.enqueue(ev('synth2', 'LOWEST', 0, true));

    const dropped = q.dropWhere((e) => e.synthetic);
    expect(dropped).toBe(2);
    expect(q.toSortedArray().map((e) => e.kind)).toEqual(['keep2', 'keep1']);
  });

  it('toSortedArray 给出确定的出队序快照而不改队列', () => {
    const q = new PriorityEventQueue();
    q.enqueue(ev('p1', 'PERCEPTION'));
    q.enqueue(ev('u1', 'URGENT'));
    expect(q.toSortedArray().map((e) => e.kind)).toEqual(['u1', 'p1']);
    expect(q.size).toBe(2);
  });
});
