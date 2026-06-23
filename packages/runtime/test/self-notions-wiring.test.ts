import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import {
  XIAOXUE_SEED,
  type PersonaSeed,
  type SelfNotionEvolver,
  type SelfNotionEvolveContext,
  type SelfNotionStrengthDelta,
} from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

const seedWithNotion: PersonaSeed = {
  ...XIAOXUE_SEED,
  selfNotions: [{ topic: ['咖啡'], position: '手冲比速溶值得。' }],
};

describe('runtime/self_notions 演化接线(§7#3)', () => {
  it('注入 evolver → 回合收尾调用 evolve(带 userText/notions/turn)', async () => {
    const calls: SelfNotionEvolveContext[] = [];
    const evolver: SelfNotionEvolver = {
      evolve: (ctx): Promise<readonly SelfNotionStrengthDelta[] | null> => {
        calls.push(ctx);
        return Promise.resolve(null); // 不实际改强度,只验证被调用与上下文
      },
    };
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm: new FakeLlm(),
      personaSeed: seedWithNotion,
      selfNotionEvolver: evolver,
      sessionId: 's',
    });
    await convo.send('手冲咖啡真香', () => {});
    expect(calls).toHaveLength(1);
    expect(calls[0]?.userText).toBe('手冲咖啡真香');
    expect(calls[0]?.turn).toBe(1);
    expect(calls[0]?.notions.some((n) => n.position.includes('手冲'))).toBe(true);
  });

  it('演化提升强度后跨"重启"(同 KV)持久', async () => {
    // 共享同一 memory(KvLike)→ 立场状态落同一 KV。
    const bus = new LightVoiceBus();
    // evolver:对"咖啡"立场给正增量。
    const evolver: SelfNotionEvolver = {
      evolve: (ctx) =>
        Promise.resolve(
          ctx.notions.length > 0
            ? [{ topicKey: ctx.notions[0]!.topic[0]!.toLowerCase(), delta: 0.1 }]
            : null,
        ),
    };
    const { createMemoryStoreFromEnv } = await import('@chat-a/memory');
    const mem = createMemoryStoreFromEnv({ CHAT_A_MEMORY_BACKEND: 'memory' } as NodeJS.ProcessEnv);
    const convo1 = new Conversation({ bus, llm: new FakeLlm(), memory: mem.store, personaSeed: seedWithNotion, selfNotionEvolver: evolver, sessionId: 'a' });
    await convo1.send('强化一下', () => {});
    // 新 Conversation 复用同一 memory(模拟重启)→ manager 从 KV 载入演化后状态。
    const convo2 = new Conversation({ bus, llm: new FakeLlm(), memory: mem.store, personaSeed: seedWithNotion, sessionId: 'b' });
    // 无直接读 manager 的公开口,改由"再演化一次读到的 notions 已带更高强度"间接验证:
    const calls: SelfNotionEvolveContext[] = [];
    const probe: SelfNotionEvolver = { evolve: (ctx) => { calls.push(ctx); return Promise.resolve(null); } };
    const convo3 = new Conversation({ bus, llm: new FakeLlm(), memory: mem.store, personaSeed: seedWithNotion, selfNotionEvolver: probe, sessionId: 'c' });
    await convo3.send('再看看', () => {});
    const notion = calls[0]?.notions.find((n) => n.topic.includes('咖啡'));
    expect(notion).toBeDefined();
    expect(notion?.strength ?? 0.5).toBeGreaterThan(0.5); // 已被 convo1 演化抬升并持久
    void convo2;
  });

  it('不注入 evolver → 默认等价(回合正常、不演化)', async () => {
    const convo = new Conversation({ bus: new LightVoiceBus(), llm: new FakeLlm(), personaSeed: seedWithNotion, sessionId: 'd' });
    const reply = await convo.send('你好', () => {});
    expect(reply).toContain('我在听');
  });
});
