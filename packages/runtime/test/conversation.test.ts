import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { InMemoryMemoryStore } from '@chat-a/memory';
import type { PersonaSnapshot, PersonaStore } from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';
import { OMNI_USER_EMOTION_DIRECTIVE, USER_EMOTION_LABELS } from '../src/user-emotion-tag';

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

  // ───────────── omni-prosody-to-pad(方案 A 显式标签) ─────────────

  it('composeOmniInstructions:末尾含情绪标签门控指令(含 user_emotion + 7 类标签)', async () => {
    const bus = new LightVoiceBus();
    const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });
    const instructions = await convo.composeOmniInstructions();
    expect(instructions).toContain('user_emotion');
    for (const label of USER_EMOTION_LABELS) expect(instructions).toContain(label);
    // 指令是末尾追加的整段(单一真相源)。
    expect(instructions).toContain(OMNI_USER_EMOTION_DIRECTIVE);
  });

  it('omni-only 隔离:send 走的系统提示不含情绪标签指令(标签指令只给 omni 路)', async () => {
    const bus = new LightVoiceBus();
    // 捕获 send 喂给 LLM 的系统提示:send 走 FakeLlm.stream,首条消息是 system。
    let capturedSystem = '';
    const llm = new FakeLlm();
    const origStream = llm.stream.bind(llm);
    (llm as unknown as { stream: typeof origStream }).stream = (
      req: Parameters<typeof origStream>[0],
      signal?: AbortSignal,
    ) => {
      capturedSystem = req.system; // LlmRequest.system 是顶层系统提示字段
      return origStream(req, signal);
    };
    const convo = new Conversation({ bus, llm, sessionId: 's1' });
    await convo.send('你好', () => {});
    expect(capturedSystem.length).toBeGreaterThan(0);
    expect(capturedSystem).not.toContain('user_emotion'); // send 路系统提示绝不含 omni 标签指令
  });

  it('advanceProsody:经同一 persona 实例把 prosody 拉力并入 PAD(happy → pleasure 上升)', async () => {
    const bus = new LightVoiceBus();
    // 捕获型 PersonaStore:记录每次 save 的 snapshot,断言 advanceProsody 推进了 PAD。
    let saved: PersonaSnapshot | null = null;
    const store: PersonaStore = {
      load: () => saved,
      save: (s) => {
        saved = s;
      },
    };
    const convo = new Conversation({ bus, llm: new FakeLlm(), personaStore: store, sessionId: 's1' });
    await convo.advanceProsody({ label: 'happy', confidence: 1 });
    // advance 会 save 一次新快照;happy 的 PAD 拉力 pleasure>0 → 从中性基线起 pleasure 应 > 0。
    expect(saved).not.toBeNull();
    expect(saved!.pad.pleasure).toBeGreaterThan(0);
  });

  it('advanceProsody:钩子内部抛错被吞(不上抛)', async () => {
    const bus = new LightVoiceBus();
    const store: PersonaStore = {
      load: () => null,
      save: () => {
        throw new Error('save 失败(模拟)');
      },
    };
    const convo = new Conversation({ bus, llm: new FakeLlm(), personaStore: store, sessionId: 's1' });
    // save 抛错经 persona.advance 冒泡到 advanceProsody 的 try/catch → 不上抛。
    await expect(convo.advanceProsody({ label: 'sad', confidence: 0.8 })).resolves.toBeUndefined();
  });
});
