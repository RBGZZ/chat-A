import { describe, it, expect } from 'vitest';
import { FakeLlm, type LlmProvider } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { Conversation, SingleShotStrategy, type TurnContext, type TurnStrategy } from '../src/conversation';

describe('runtime/TurnStrategy 接缝(§9 P3 前置)', () => {
  describe('SingleShotStrategy 契约(等价基线)', () => {
    it('不注入 strategy(默认 SingleShotStrategy):流式回复 + emit turn:start/end + correlationId', async () => {
      const bus = new LightVoiceBus();
      const actions: string[] = [];
      bus.onAny((e) => actions.push(e.action));
      const convo = new Conversation({ bus, llm: new FakeLlm(), sessionId: 's1' });

      const tokens: string[] = [];
      const reply = await convo.send('你好小雪', (t) => tokens.push(t));

      // 与现状逐字一致:FakeLlm 引用用户最后一句、token 拼回回复、事件序、correlationId。
      expect(reply).toContain('你好小雪');
      expect(tokens.join('')).toBe(reply);
      expect(actions).toEqual(['turn:start', 'turn:end']);
      expect(bus.history().at(-1)?.correlationId).toBe('s1/t1/0');
    });

    it('显式注入 SingleShotStrategy 与默认行为一致', async () => {
      const bus = new LightVoiceBus();
      const convo = new Conversation({ bus, llm: new FakeLlm(), strategy: new SingleShotStrategy(), sessionId: 's1' });
      const reply = await convo.send('你好小雪', () => {});
      expect(reply).toContain('你好小雪');
    });
  });

  describe('注入自定义 TurnStrategy 可替换回合执行', () => {
    it('自定义策略替换回合体:返回自定义回复、默认 LLM 流程未执行,外壳仍 emit 生命周期', async () => {
      const bus = new LightVoiceBus();
      const actions: string[] = [];
      bus.onAny((e) => actions.push(e.action));

      // 若默认流程跑了会调用 llm.stream;此处断言它没被调用。
      let llmCalled = false;
      const spyLlm: LlmProvider = {
        id: 'spy',
        model: 'spy-1',
        async *stream() {
          llmCalled = true;
          yield 'should-not-run';
        },
        async complete() {
          return '';
        },
      };

      const seen: TurnContext[] = [];
      const fake: TurnStrategy = {
        async run(ctx) {
          seen.push(ctx);
          ctx.onToken('自定义');
          return '自定义回复';
        },
      };

      const convo = new Conversation({ bus, llm: spyLlm, strategy: fake, sessionId: 'c1' });
      const tokens: string[] = [];
      const reply = await convo.send('随便', (t) => tokens.push(t));

      // 回合体被替换:返回值与 token 来自自定义策略,默认 LLM 未被触达。
      expect(reply).toBe('自定义回复');
      expect(tokens).toEqual(['自定义']);
      expect(llmCalled).toBe(false);
      // 外壳生命周期照常运转。
      expect(actions).toEqual(['turn:start', 'turn:end']);
      // 外壳把 per-turn 上下文填进 TurnContext(turnId/correlationId/turnSpan/turnStartMs)。
      expect(seen).toHaveLength(1);
      const ctx = seen[0]!;
      expect(ctx.turnId).toBe('t1');
      expect(ctx.correlationId).toBe('c1/t1/0');
      expect(ctx.userText).toBe('随便');
      expect(typeof ctx.turnStartMs).toBe('number');
      expect(ctx.turnSpan).toBeDefined();
      expect(ctx.deps.sessionId).toBe('c1');
    });

    it('自定义策略下 correlationId 跨回合递增(外壳负责生命周期)', async () => {
      const bus = new LightVoiceBus();
      const fake: TurnStrategy = { run: async () => 'ok' };
      const convo = new Conversation({ bus, llm: new FakeLlm(), strategy: fake, sessionId: 's1' });
      await convo.send('一', () => {});
      await convo.send('二', () => {});
      const starts = bus.history().filter((e) => e.action === 'turn:start');
      expect(starts.map((e) => e.correlationId)).toEqual(['s1/t1/0', 's1/t2/0']);
    });

    it('策略 run 抛错 → 外壳 emit turn:end{error} 并重抛(降级语义不变,§3.2)', async () => {
      const bus = new LightVoiceBus();
      const reasons: string[] = [];
      bus.on('turn:end', (e) => reasons.push(e.data.reason));
      const boom: TurnStrategy = {
        run: async () => {
          throw new Error('strategy boom');
        },
      };
      const convo = new Conversation({ bus, llm: new FakeLlm(), strategy: boom, sessionId: 'e1' });
      await expect(convo.send('你好', () => {})).rejects.toThrow('strategy boom');
      expect(reasons.at(-1)).toBe('error');
    });
  });
});
