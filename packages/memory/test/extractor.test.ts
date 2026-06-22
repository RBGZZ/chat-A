import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { LlmMemoryExtractor, NoopMemoryExtractor, InMemoryMemoryStore } from '../src/index';

describe('memory/MemoryExtractor', () => {
  it('Noop 不抽取', async () => {
    expect(await new NoopMemoryExtractor().extract('hi', 'yo')).toEqual([]);
  });

  it('LLM 抽取两条 + 写入去重(其一与既有等价)', async () => {
    const provider = new FakeLlm('fake', {
      complete: '[{"text":"用户叫小明"},{"text":"用户喜欢猫"}]',
    });
    const store = new InMemoryMemoryStore();
    store.addMemory({ text: '用户叫小明' }); // 既有
    const items = await new LlmMemoryExtractor({ provider }).extract('我叫小明，喜欢猫', 'ok');
    expect(items.map((i) => i.text)).toEqual(['用户叫小明', '用户喜欢猫']);
    for (const it of items) store.addMemory(it);
    // “用户叫小明”去重(hits 累加不增行);“用户喜欢猫”新增。
    expect(store.recall('小明').length).toBe(1);
    expect(store.recall('猫').length).toBe(1);
  });

  it('乱码 → 返回空,不抛', async () => {
    const provider = new FakeLlm('fake', { complete: '我想想……没有要点' });
    expect(await new LlmMemoryExtractor({ provider }).extract('闲聊', 'ok')).toEqual([]);
  });
});
