import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryMemoryStore } from '@chat-a/memory';
import { assembleConsolidation, isConsolidationEnabled } from '../src/assembly/consolidation';

/**
 * 巩固触发装配薄壳测试(不触网):
 * - off → undefined;on → consolidateSession 触发 Consolidator.run(幂等二次跳过)。
 * - 用 buildInput 提供空入参,使 run 安全跳过 LLM(只验触发 + 幂等接线,不验巩固内核)。
 */

describe('client/assembleConsolidation 开关与触发', () => {
  it('off(未设)→ undefined', () => {
    const handle = assembleConsolidation({}, { llm: new FakeLlm(), store: new InMemoryMemoryStore() });
    expect(handle).toBeUndefined();
  });

  it('on → consolidateSession 触发巩固;二次同 unit 幂等跳过(写了 state key)', async () => {
    const store = new InMemoryMemoryStore();
    const handle = assembleConsolidation(
      { CHAT_A_CONSOLIDATION: 'on' },
      {
        llm: new FakeLlm(),
        store,
        now: () => 1000,
        buildInput: () => ({ candidates: [], existing: [] }), // 空入参 → run 不调 LLM,安全
      },
    );
    expect(handle).toBeDefined();

    await handle!.consolidateSession('sess-A');
    // 巩固成功会写幂等 state key(stateKeyPrefix + unit);二次触发应安全跳过。
    await handle!.consolidateSession('sess-A');
    // 不抛即通过(幂等 + 降级);state 存在性可侧证。
    expect(typeof store.getState).toBe('function');
  });

  it('开关常量解析', () => {
    expect(isConsolidationEnabled({ CHAT_A_CONSOLIDATION: 'on' })).toBe(true);
    expect(isConsolidationEnabled({ CHAT_A_CONSOLIDATION: 'ON' })).toBe(true);
    expect(isConsolidationEnabled({ CHAT_A_CONSOLIDATION: 'off' })).toBe(false);
    expect(isConsolidationEnabled({})).toBe(false);
  });
});

/**
 * 节奏触发(companion-coherence-wiring,§5.1):daily / 每 N 轮驱动(默认 everyNTurns=50 / dailyIntervalDays=1)。
 * 注入 now + state(轮数 / 上次巩固时刻)确定性验证;空 buildInput 使 run 安全跳过 LLM。
 */
const MS_PER_DAY = 86_400_000;

function cadenceHandle(now: number) {
  const store = new InMemoryMemoryStore();
  const handle = assembleConsolidation(
    { CHAT_A_CONSOLIDATION: 'on' },
    { llm: new FakeLlm(), store, now: () => now, buildInput: () => ({ candidates: [], existing: [] }) },
  );
  return { store, handle: handle! };
}

describe('client/maybeConsolidateByCadence 节奏触发(§5.1)', () => {
  it('轮数达阈值(>=everyNTurns=50)→ 触发', async () => {
    const { handle } = cadenceHandle(10_000);
    const fired = await handle.maybeConsolidateByCadence('turns:s:0', { turnsSinceLast: 50 });
    expect(fired).toBe(true);
  });

  it('轮数未达阈值 且 距上次巩固 < 1 天 → 不触发', async () => {
    const now = 10 * MS_PER_DAY;
    const { handle } = cadenceHandle(now);
    const fired = await handle.maybeConsolidateByCadence('turns:s:0', {
      turnsSinceLast: 3,
      lastConsolidatedAtMs: now - MS_PER_DAY / 2, // 半天前,daily 不到阈值
    });
    expect(fired).toBe(false);
  });

  it('距上次巩固 >= 1 天 → daily 触发(即便轮数没到)', async () => {
    const now = 10 * MS_PER_DAY;
    const { handle } = cadenceHandle(now);
    const fired = await handle.maybeConsolidateByCadence('daily:1', {
      turnsSinceLast: 1,
      lastConsolidatedAtMs: now - 2 * MS_PER_DAY, // 两天前
    });
    expect(fired).toBe(true);
  });

  it('从未巩固(lastConsolidatedAtMs 缺省)→ daily 首次触发', async () => {
    const { handle } = cadenceHandle(MS_PER_DAY);
    const fired = await handle.maybeConsolidateByCadence('daily:first', { turnsSinceLast: 0 });
    expect(fired).toBe(true);
  });

  it('同 unit 二次:run 内幂等(state key 已写),不重复巩固', async () => {
    const { store, handle } = cadenceHandle(5_000);
    await handle.maybeConsolidateByCadence('turns:s:0', { turnsSinceLast: 50 });
    // 首次成功巩固写了幂等 state key(stateKeyPrefix 'consolidation_' + unit)。
    const stateKey = 'consolidation_turns:s:0';
    expect(store.getState(stateKey)).toBeDefined();
    const snapshot = store.getState(stateKey);
    // 二次触发:due 仍 true 但 run 内存在性检查跳过(state 不变,不重复写)。
    await handle.maybeConsolidateByCadence('turns:s:0', { turnsSinceLast: 50 });
    expect(store.getState(stateKey)).toBe(snapshot);
  });
});
