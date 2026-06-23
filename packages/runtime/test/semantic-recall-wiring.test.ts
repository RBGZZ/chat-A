import { describe, it, expect, vi } from 'vitest';
import { FakeLlm, type Embedder } from '@chat-a/providers';
import { createMemoryStoreFromEnv } from '@chat-a/memory';
import { type DecisionTraceSink } from '@chat-a/observability';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/** 确定性 fake embedder:任意文本 → 固定 3 维向量(便于断言 queryVector 透传)。 */
function fakeEmbedder(): Embedder {
  return { id: 'fake', name: 'fake', dimension: 3, embed: (texts) => Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])) };
}

function recordingSink(): { sink: DecisionTraceSink; records: Parameters<DecisionTraceSink['record']>[0][] } {
  const records: Parameters<DecisionTraceSink['record']>[0][] = [];
  return { sink: { record: (r) => { records.push(r); }, close: () => {} }, records };
}

const MEM_ENV = { CHAT_A_MEMORY_BACKEND: 'memory' } as NodeJS.ProcessEnv;

describe('runtime/c2b 语义召回接线（非阻塞）', () => {
  it('注入 embedder → recallHybrid 收到 queryVector + trace semanticUsed=true', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    const hybridSpy = vi.spyOn(mem.store, 'recallHybrid');
    const { sink, records } = recordingSink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, embedder: fakeEmbedder(), traceSink: sink, sessionId: 'sem' });
    await convo.send('hello', () => {});
    expect(hybridSpy).toHaveBeenCalled();
    expect(hybridSpy.mock.calls[0]?.[1]?.queryVector).toEqual([0.1, 0.2, 0.3]);
    expect(records[0]?.semanticUsed).toBe(true);
  });

  it('不注入 embedder → 关键词快路径(不调 recallHybrid),trace 无 semanticUsed', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    const hybridSpy = vi.spyOn(mem.store, 'recallHybrid');
    const recallSpy = vi.spyOn(mem.store, 'recall');
    const { sink, records } = recordingSink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, traceSink: sink, sessionId: 'kw' });
    await convo.send('hello', () => {});
    expect(hybridSpy).not.toHaveBeenCalled();
    expect(recallSpy).toHaveBeenCalled();
    expect(records[0]?.semanticUsed).toBeUndefined();
  });

  it('写侧:启用 embedder 时回合收尾触发后台嵌入(memoriesNeedingEmbedding 被调用)', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    const needSpy = vi.spyOn(mem.store, 'memoriesNeedingEmbedding');
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, embedder: fakeEmbedder(), sessionId: 'write' });
    await convo.send('记住我喜欢猫', () => {});
    expect(needSpy).toHaveBeenCalled();
  });
});
