import { describe, it, expect } from 'vitest';
import { createMemoryFactLookup, createRecallFactAction, type FactRecallStore, type FactRecord } from '../src/index';

/** 构造一条最小可用的召回记录(只填适配器关心的字段)。 */
function rec(text: string): FactRecord {
  return { text };
}

/** 可控的假 store:按预设映射返回命中,或抛错以验证降级。 */
function fakeStore(map: Record<string, readonly FactRecord[]>, opts: { throwOn?: string } = {}): FactRecallStore {
  return {
    recall(query: string, limit?: number): readonly FactRecord[] {
      if (opts.throwOn !== undefined && query === opts.throwOn) {
        throw new Error('boom');
      }
      const hits = map[query] ?? [];
      return typeof limit === 'number' ? hits.slice(0, limit) : hits;
    },
  };
}

describe('interaction/createMemoryFactLookup(真 memory.recall 适配)', () => {
  it('命中 → 返回首条记忆文本', () => {
    const store = fakeStore({ 用户爱好: [rec('用户喜欢爬山')] });
    const lookup = createMemoryFactLookup(store);
    expect(lookup('用户爱好')).toBe('用户喜欢爬山');
  });

  it('多条命中 → 受 topN 约束、按召回顺序拼接', () => {
    const store = fakeStore({ k: [rec('一'), rec('二'), rec('三')] });
    const lookup = createMemoryFactLookup(store, { topN: 2 });
    const out = lookup('k');
    expect(out).toContain('一');
    expect(out).toContain('二');
    expect(out).not.toContain('三');
  });

  it('topN 透传给 store.recall 的 limit', () => {
    let seenLimit: number | undefined;
    const store: FactRecallStore = {
      recall(_q: string, limit?: number) {
        seenLimit = limit;
        return [rec('x')];
      },
    };
    createMemoryFactLookup(store, { topN: 3 })('q');
    expect(seenLimit).toBe(3);
  });

  it('空结果 → undefined(交由 recall_fact 表达"想不起",非崩溃)', () => {
    const store = fakeStore({});
    const lookup = createMemoryFactLookup(store);
    expect(lookup('不存在的')).toBeUndefined();
  });

  it('store.recall 抛错 → 优雅降级为 undefined(永不崩,§3.2)', () => {
    const store = fakeStore({ q: [rec('有')] }, { throwOn: 'q' });
    const lookup = createMemoryFactLookup(store);
    expect(lookup('q')).toBeUndefined();
  });

  it('命中文本为空白 → 视为未命中(undefined)', () => {
    const store = fakeStore({ q: [rec('   ')] });
    const lookup = createMemoryFactLookup(store);
    expect(lookup('q')).toBeUndefined();
  });

  it('接入 recall_fact 动作:命中走真检索结果(非 error)', async () => {
    const store = fakeStore({ 生日: [rec('用户生日是 5 月 1 日')] });
    const action = createRecallFactAction(createMemoryFactLookup(store));
    const r = await action.perform({ query: '生日' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('5 月 1 日');
  });

  it('接入 recall_fact 动作:空结果优雅降级为"想不起"(非 error)', async () => {
    const store = fakeStore({});
    const action = createRecallFactAction(createMemoryFactLookup(store));
    const r = await action.perform({ query: '完全不知道' });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain('想不起');
  });
});
