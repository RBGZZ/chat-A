import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { LlmReflector, NoopReflector, InMemoryMemoryStore } from '../src/index';
import type { MemoryStore } from '../src/index';

/** 往 store 写入一段简单会话(默认会话 's')。 */
function seedConversation(store: MemoryStore, sessionId = 's'): void {
  store.appendMessage({ sessionId, turnId: 't1', role: 'user', content: '我下周要考试,好紧张', createdAtMs: 1 });
  store.appendMessage({ sessionId, turnId: 't1', role: 'assistant', content: '别怕,我陪你复习', createdAtMs: 2 });
}

/** 罐装一份合法蒸馏 JSON。 */
const GOOD_JSON = JSON.stringify({
  highlights: [
    { q: '用户下周考试紧张吗?', a: '紧张,小雪安慰并陪复习' },
    { q: '聊了什么?', a: '考试与情绪' },
  ],
  diary: '今天用户跟我说快考试了很紧张,我陪她聊了会儿,感觉我们更近了。',
});

describe('memory/Reflector', () => {
  it('Noop 不沉淀、不抛、不写库', async () => {
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    await new NoopReflector().reflect('s');
    // 无任何 reflection 记忆。
    expect(store.recall('考试')).toEqual([]);
  });

  it('LlmReflector 蒸馏写回:shared 高层 Q&A + agent 第一人称,均可召回', async () => {
    const provider = new FakeLlm('fake', { complete: GOOD_JSON });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    await new LlmReflector({ provider, store }).reflect('s');

    // 高层 Q&A → shared(用只出现在 highlight 里的词召回,避开日记)。
    const shared = store.recall('陪复习');
    expect(shared.length).toBeGreaterThan(0);
    expect(shared.every((r) => r.subject === 'shared')).toBe(true);
    expect(shared.every((r) => r.kind === 'reflection')).toBe(true);

    // 第一人称自传 → agent(不关联人)。
    const agent = store.recall('更近');
    expect(agent.length).toBe(1);
    expect(agent[0]?.subject).toBe('agent');
    expect(agent[0]?.personId).toBeUndefined();
    expect(agent[0]?.kind).toBe('reflection');
  });

  it('高层 Q&A 受 maxHighlights 上限约束', async () => {
    const many = JSON.stringify({
      highlights: [
        { q: 'q1', a: 'a1' },
        { q: 'q2', a: 'a2' },
        { q: 'q3', a: 'a3' },
      ],
      diary: '日记',
    });
    const provider = new FakeLlm('fake', { complete: many });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    await new LlmReflector({ provider, store, config: { maxHighlights: 2 } }).reflect('s');
    // 只写回 2 条 shared 高层 + 1 条 agent 日记。
    const shared = store.recall('q1 q2 q3');
    expect(shared.filter((r) => r.subject === 'shared').length).toBe(2);
  });

  it('写回复用 ADD 去重:与既有等价不增行', async () => {
    const dup = JSON.stringify({ highlights: [{ q: '主旨', a: '同一条' }], diary: '日记甲' });
    const provider = new FakeLlm('fake', { complete: dup });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    // 预置一条与将写回等价的记忆。
    store.addMemory({ text: 'Q：主旨 A：同一条', kind: 'reflection', subject: 'shared' });
    await new LlmReflector({ provider, store }).reflect('s');
    // 去重:仍只有一条。
    expect(store.recall('主旨').length).toBe(1);
  });

  it('幂等:同 sessionId 二次 reflect 不再调 LLM、不增行', async () => {
    let calls = 0;
    const provider = new FakeLlm('fake', {
      complete: () => {
        calls += 1;
        return GOOD_JSON;
      },
    });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    const reflector = new LlmReflector({ provider, store });
    await reflector.reflect('s');
    const after1 = store.recall('考试').length;
    await reflector.reflect('s');
    expect(calls).toBe(1); // 第二次跳过,未再调 LLM
    expect(store.recall('考试').length).toBe(after1); // 未增行
  });

  it('无消息 → 跳过、不调 LLM、不打标记', async () => {
    let calls = 0;
    const provider = new FakeLlm('fake', {
      complete: () => {
        calls += 1;
        return GOOD_JSON;
      },
    });
    const store = new InMemoryMemoryStore();
    // 不写任何消息。
    await new LlmReflector({ provider, store }).reflect('empty');
    expect(calls).toBe(0);
    expect(store.getState('diary_empty')).toBeUndefined();
  });

  it('LLM 失败 → 不抛、不写回、不打标记(允许下次重试)', async () => {
    const provider = new FakeLlm('fake', {
      complete: () => {
        throw new Error('boom');
      },
    });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    let errored: unknown;
    await new LlmReflector({ provider, store, onError: (e) => (errored = e) }).reflect('s');
    expect(errored).toBeInstanceOf(Error);
    expect(store.recall('考试')).toEqual([]);
    expect(store.getState('diary_s')).toBeUndefined();
  });

  it('解析失败(乱码)→ 不写回、不抛', async () => {
    const provider = new FakeLlm('fake', { complete: '我想想……没有结构化结果' });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    await new LlmReflector({ provider, store }).reflect('s');
    expect(store.recall('考试')).toEqual([]);
    // 全非法 → 未写回 → 不打标记。
    expect(store.getState('diary_s')).toBeUndefined();
  });

  it("enabled='off' 等价 Noop 语义", async () => {
    let calls = 0;
    const provider = new FakeLlm('fake', {
      complete: () => {
        calls += 1;
        return GOOD_JSON;
      },
    });
    const store = new InMemoryMemoryStore();
    seedConversation(store);
    await new LlmReflector({ provider, store, config: { enabled: 'off' } }).reflect('s');
    expect(calls).toBe(0);
    expect(store.recall('考试')).toEqual([]);
  });
});
