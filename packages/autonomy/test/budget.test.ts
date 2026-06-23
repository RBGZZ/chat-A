import { describe, expect, it } from 'vitest';
import {
  consumeOnNoAction,
  createBudgetState,
  isReconsiderEvent,
  resetBudget,
} from '../src/budget';
import { resolveAutonomyConfig } from '../src/config';
import { PriorityEventQueue } from '../src/priority-queue';
import { RECONSIDER_EVENT_KIND, type Clock } from '../src/types';

/** fake 时钟:可控当前时刻(确定性)。 */
function fakeClock(start = 1000): Clock & { set(n: number): void } {
  let t = start;
  return { now: () => t, set: (n: number) => void (t = n) };
}

describe('no-action 预算节流(§7)', () => {
  it('默认上限来自 config(默认 3,行为即配置)', () => {
    const cfg = resolveAutonomyConfig();
    expect(cfg.maxNoActionRetries).toBe(3);
    expect(createBudgetState(cfg).remaining).toBe(3);
  });

  it('无产出 → 扣 1 并合成 LOWEST「再想一次」事件入队', () => {
    const cfg = resolveAutonomyConfig();
    const state = createBudgetState(cfg);
    const q = new PriorityEventQueue();
    const clock = fakeClock(5000);

    const did = consumeOnNoAction(state, q, clock);
    expect(did).toBe(true);
    expect(state.remaining).toBe(2);
    expect(q.size).toBe(1);

    const synth = q.peek()!;
    expect(synth.kind).toBe(RECONSIDER_EVENT_KIND);
    expect(synth.priority).toBe('LOWEST');
    expect(synth.synthetic).toBe(true);
    expect(synth.atMs).toBe(5000); // 用注入时钟打时间戳
    expect(isReconsiderEvent(synth)).toBe(true);
  });

  it('连续无产出扣到 0 后停止合成(不空转)', () => {
    const cfg = resolveAutonomyConfig({ maxNoActionRetries: 2 });
    const state = createBudgetState(cfg);
    const q = new PriorityEventQueue();
    const clock = fakeClock();

    expect(consumeOnNoAction(state, q, clock)).toBe(true); // 2→1,合成 1
    expect(consumeOnNoAction(state, q, clock)).toBe(true); // 1→0,合成 1
    expect(consumeOnNoAction(state, q, clock)).toBe(false); // 0:不再合成
    expect(state.remaining).toBe(0);
    expect(q.size).toBe(2); // 只合成了 2 个
  });

  it('外部重置:复位预算 + 丢弃所有合成自言自语,保留非合成事件', () => {
    const cfg = resolveAutonomyConfig({ maxNoActionRetries: 3 });
    const state = createBudgetState(cfg);
    const q = new PriorityEventQueue();
    const clock = fakeClock();

    // 放一个真实感知事件 + 扣两次预算(合成两条自言自语)。
    q.enqueue({ kind: 'user:speech', priority: 'URGENT', synthetic: false, atMs: 0 });
    consumeOnNoAction(state, q, clock);
    consumeOnNoAction(state, q, clock);
    expect(state.remaining).toBe(1);
    expect(q.size).toBe(3);

    const dropped = resetBudget(state, q, cfg);
    expect(dropped).toBe(2); // 两条合成被丢
    expect(state.remaining).toBe(3); // 预算复位满额
    expect(q.size).toBe(1);
    expect(q.peek()?.kind).toBe('user:speech'); // 非合成事件保留
  });

  it('isReconsiderEvent 只认 synthetic+LOWEST+指定 kind', () => {
    expect(
      isReconsiderEvent({ kind: RECONSIDER_EVENT_KIND, priority: 'LOWEST', synthetic: true, atMs: 0 }),
    ).toBe(true);
    // 非合成
    expect(
      isReconsiderEvent({ kind: RECONSIDER_EVENT_KIND, priority: 'LOWEST', synthetic: false, atMs: 0 }),
    ).toBe(false);
    // 优先级不对
    expect(
      isReconsiderEvent({ kind: RECONSIDER_EVENT_KIND, priority: 'URGENT', synthetic: true, atMs: 0 }),
    ).toBe(false);
  });
});
