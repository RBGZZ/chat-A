import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryMemoryStore } from '@chat-a/memory';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

describe('runtime/Conversation(端到端回合,FakeLlm)', () => {
  it('流式回复 + 落历史 + 发 turn:start/turn:end', async () => {
    const bus = new LightVoiceBus();
    const actions: string[] = [];
    bus.onAny((e) => actions.push(e.action));
    const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });

    const tokens: string[] = [];
    const reply = await convo.send('你好小雪', (t) => tokens.push(t));

    expect(reply).toContain('你好小雪'); // FakeLlm 引用用户最后一句
    expect(tokens.join('')).toBe(reply); // 流式 token 拼回完整回复
    expect(actions).toEqual(['turn:start', 'turn:end']);
    const end = bus.history().at(-1);
    expect(end?.action).toBe('turn:end');
    expect(end?.correlationId).toBe('s1/t1/0');
  });

  it('第二回合带上历史(correlationId 递增)', async () => {
    const bus = new LightVoiceBus();
    const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });
    await convo.send('一', () => {});
    await convo.send('二', () => {});
    const starts = bus.history().filter((e) => e.action === 'turn:start');
    expect(starts.map((e) => e.correlationId)).toEqual(['s1/t1/0', 's1/t2/0']);
  });

  it('composeOmniInstructions:复用既有组装,返回含人设骨架(身份)的非空系统提示', async () => {
    const bus = new LightVoiceBus();
    const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });
    const instructions = await convo.composeOmniInstructions();
    expect(instructions.length).toBeGreaterThan(0);
    // 复用与 send 同源的 persona 骨架 → 含人设身份(默认 XIAOXUE 名「小雪」)。
    expect(instructions).toContain('小雪');
  });

  it('composeOmniInstructions:内部组装失败 → 兜底返回 persona 骨架(非空、不抛)', async () => {
    const bus = new LightVoiceBus();
    // 用真 InMemoryMemoryStore(满足构造期 KV 等依赖),仅把 getCloseness 改成抛错,
    // 触发 composeOmniInstructions 外层 catch → 兜底返回骨架。
    const store = new InMemoryMemoryStore();
    store.getCloseness = () => {
      throw new Error('memory 读失败(模拟)');
    };
    const convo = new Conversation({ bus, llm: new FakeLlm(), memory: store, sessionId: 's1' });
    const instructions = await convo.composeOmniInstructions();
    // 兜底:返回 persona 骨架(非空,含身份),不抛。
    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions).toContain('小雪');
  });
});
