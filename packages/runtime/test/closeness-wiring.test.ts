import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { createMemoryStoreFromEnv } from '@chat-a/memory';
import { type DecisionTraceSink } from '@chat-a/observability';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/** 记录每回合落 trace 的记录(含组装的 system),用于断言 tone 是否吃到 closeness。 */
function recordingSink(): { sink: DecisionTraceSink; records: Parameters<DecisionTraceSink['record']>[0][] } {
  const records: Parameters<DecisionTraceSink['record']>[0][] = [];
  return { sink: { record: (r) => { records.push(r); }, close: () => {} }, records };
}

const MEM_ENV = { CHAT_A_MEMORY_BACKEND: 'memory' } as NodeJS.ProcessEnv;

describe('runtime/closeness 回合接线(§6.1b Task4)', () => {
  it('回合前用主用户 closeness 渲染 tone:高 closeness → system 含"亲近"', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    // 用"当下"时间戳把主用户 closeness 推到亲近档(valence=1 多次,渐近 →1;decay≈0)。
    const now = Date.now();
    for (let i = 0; i < 30; i++) mem.store.bumpCloseness('primary', 1, now);
    const { sink, records } = recordingSink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, traceSink: sink, sessionId: 'near' });
    await convo.send('hi', () => {});
    expect(records).toHaveLength(1);
    expect(records[0]?.system).toContain('亲近');
  });

  it('默认低 closeness(0.1)→ system 含"克制"(疏远档)', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    const { sink, records } = recordingSink();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, traceSink: sink, sessionId: 'far' });
    await convo.send('hi', () => {});
    expect(records[0]?.system).toContain('克制');
  });

  it('回合收尾写入 closeness 记录(bumpCloseness 已调用,非阻塞)', async () => {
    const mem = createMemoryStoreFromEnv(MEM_ENV);
    const farFuture = Date.now() + 365 * 24 * 3600 * 1000;
    // 回合前:无记录 → getClosenessAt(远期)= 初值 0.1,不随时间衰减。
    expect(mem.store.getClosenessAt('primary', farFuture)).toBeCloseTo(0.1, 5);
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), memory: mem.store, sessionId: 'bump' });
    await convo.send('hi', () => {});
    // 回合后:收尾已 bump 写入记录(带回合时刻时间戳)→ getClosenessAt(远期)随时间衰减 < 0.1。
    expect(mem.store.getClosenessAt('primary', farFuture)).toBeLessThan(0.1);
  });
});
