import { describe, it, expect, vi } from 'vitest';
import type { Embedder } from '@chat-a/providers';
import { QueryEmbedder } from '../src/query-embed';

// 真实 Embedder 类型要求 name 字段（仅供 trace/日志），故补上以对齐类型。
function fakeEmbedder(impl: (t: string) => Promise<number[]>): Embedder {
  return { id: 'fake', name: 'fake', dimension: 3, embed: async (texts) => [await impl(texts[0]!)] };
}

describe('runtime/QueryEmbedder（非阻塞 query 嵌入）', () => {
  it('正常:返回向量,cacheHit=false', async () => {
    const qe = new QueryEmbedder(fakeEmbedder(async () => [1, 2, 3]));
    const r = await qe.embed('hi');
    expect(r.vector).toEqual([1, 2, 3]);
    expect(r.cacheHit).toBe(false);
    expect(r.timedOut).toBe(false);
  });
  it('缓存命中:第二次同 query 直接命中', async () => {
    const spy = vi.fn(async () => [1, 2, 3]);
    const qe = new QueryEmbedder(fakeEmbedder(spy));
    await qe.embed('x');
    const r2 = await qe.embed('x');
    expect(r2.cacheHit).toBe(true);
    expect(r2.vector).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('超时:超 budgetMs → vector=null, timedOut=true,不抛', async () => {
    const slow = fakeEmbedder(() => new Promise((res) => setTimeout(() => res([9]), 1000)));
    const qe = new QueryEmbedder(slow, { budgetMs: 10 });
    const r = await qe.embed('slow');
    expect(r.vector).toBeNull();
    expect(r.timedOut).toBe(true);
  });
  it('embed 抛错 → vector=null,不抛', async () => {
    const bad = fakeEmbedder(() => Promise.reject(new Error('boom')));
    const qe = new QueryEmbedder(bad, { budgetMs: 50 });
    const r = await qe.embed('e');
    expect(r.vector).toBeNull();
  });
});
