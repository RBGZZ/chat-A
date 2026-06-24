import { describe, it, expect } from 'vitest';
import { LightVoiceBus } from '@chat-a/runtime';
import {
  assemblePerception,
  isPerceptionEnabled,
  loadPerceptionTickMs,
  DEFAULT_PERCEPTION_TICK_MS,
} from '../src/assembly/perception';

/**
 * 感知装配薄壳测试(不触网、不碰真硬件):
 * 注入 fake schedule/clock 手动驱动 system.tick + 聚合窗 flush,断言真 bus 收到 signal:perception。
 */

/** 收集所有挂起的定时回调,手动逐个触发(setTimeout/setInterval 共用此 fake)。 */
function makeFakeScheduler() {
  const pending: Array<{ fn: () => void; cancelled: boolean }> = [];
  const schedule = (fn: () => void): (() => void) => {
    const entry = { fn, cancelled: false };
    pending.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };
  const flushAll = (): void => {
    for (const e of pending) if (!e.cancelled) e.fn();
  };
  return { schedule, flushAll };
}

describe('client/assemblePerception 开关与总线连通', () => {
  it('CHAT_A_PERCEPTION=on:system.tick 一拍 → 真 bus 收到 signal:perception', async () => {
    const bus = new LightVoiceBus();
    const seen: string[] = [];
    bus.onAny((e) => {
      if (e.action.startsWith('signal:')) seen.push(e.action);
    });

    const fake = makeFakeScheduler();
    // 固定时钟:raw 的 atMs 与聚合窗 flush 的 nowMs 同值,确保落在聚合窗 [now-300, now] 内。
    const handle = await assemblePerception(
      { CHAT_A_PERCEPTION: 'on' },
      bus,
      { now: () => 5000, schedule: fake.schedule },
    );
    expect(handle).toBeDefined();

    // 驱动:第一次 flush 触发 tick 源的周期回调 emit raw → 开聚合窗(又一个 schedule);再 flush 聚合窗。
    fake.flushAll(); // tick 源周期回调 → emit raw → 排聚合窗
    fake.flushAll(); // 聚合窗到期 → fire signal

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((a) => a.startsWith('signal:'))).toBe(true);
    await handle!.stop();
  });

  it('缺省(未设 CHAT_A_PERCEPTION)→ 返回 undefined,bus 零新事件', async () => {
    const bus = new LightVoiceBus();
    const seen: string[] = [];
    bus.onAny((e) => seen.push(e.action));
    const handle = await assemblePerception({}, bus);
    expect(handle).toBeUndefined();
    expect(seen.length).toBe(0);
  });

  it('非 on 值(off/任意)→ 关', () => {
    expect(isPerceptionEnabled({ CHAT_A_PERCEPTION: 'off' })).toBe(false);
    expect(isPerceptionEnabled({ CHAT_A_PERCEPTION: 'yes' })).toBe(false);
    expect(isPerceptionEnabled({ CHAT_A_PERCEPTION: 'ON' })).toBe(true);
    expect(isPerceptionEnabled({})).toBe(false);
  });

  it('tick 周期:非法/缺省回落默认,合法值采纳', () => {
    expect(loadPerceptionTickMs({})).toBe(DEFAULT_PERCEPTION_TICK_MS);
    expect(loadPerceptionTickMs({ CHAT_A_PERCEPTION_TICK_MS: 'abc' })).toBe(DEFAULT_PERCEPTION_TICK_MS);
    expect(loadPerceptionTickMs({ CHAT_A_PERCEPTION_TICK_MS: '-5' })).toBe(DEFAULT_PERCEPTION_TICK_MS);
    expect(loadPerceptionTickMs({ CHAT_A_PERCEPTION_TICK_MS: '3000' })).toBe(3000);
  });
});
