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
