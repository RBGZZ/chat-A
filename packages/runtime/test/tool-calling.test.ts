import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { ActionRegistry, type Action } from '@chat-a/interaction';
import type { DecisionTrace, DecisionTraceSink } from '@chat-a/observability';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';
import { ToolCallingStrategy } from '../src/tool-calling-strategy';

/** 记数动作:返回固定内容并累计被调次数。 */
function spyAction(name: string, onCall: () => void): Action {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {}, required: [] },
    perform: () => {
      onCall();
      return Promise.resolve({ content: 'pong' });
    },
  };
}

describe('runtime/ToolCallingStrategy (Agent loop)', () => {
  it('工具往返:执行动作 → 回灌 → 最终文本经 onToken 返回', async () => {
    let called = 0;
    const registry = new ActionRegistry().register(spyAction('ping', () => (called += 1)));
    const llm = new FakeLlm('fake', {
      toolScript: [{ toolCalls: [{ id: 'c1', name: 'ping', input: {} }] }, { text: '工具说 pong,知道了' }],
    });
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      strategy: new ToolCallingStrategy({ registry }),
      sessionId: 't',
    });
    let out = '';
    const reply = await convo.send('帮我 ping 一下', (t) => (out += t));
    expect(called).toBe(1);
    expect(reply).toBe('工具说 pong,知道了');
    expect(out).toBe(reply);
  });

  it('达 maxIters 上限即停,不无限循环', async () => {
    let called = 0;
    const registry = new ActionRegistry().register(spyAction('ping', () => (called += 1)));
    // 脚本每轮都发起 tool_use,靠 maxIters 兜住。
    const llm = new FakeLlm('fake', {
      toolScript: [
        { toolCalls: [{ id: 'a', name: 'ping', input: {} }] },
        { toolCalls: [{ id: 'b', name: 'ping', input: {} }] },
        { toolCalls: [{ id: 'c', name: 'ping', input: {} }] },
      ],
    });
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      strategy: new ToolCallingStrategy({ registry, maxIters: 2 }),
      sessionId: 't',
    });
    await convo.send('循环', () => {});
    expect(called).toBe(2); // 恰好 maxIters 次,未失控
  });

  it('Provider 不支持工具 → 降级回单趟(产出 stream 文本)', async () => {
    const registry = new ActionRegistry().register(spyAction('ping', () => {}));
    const llm = new FakeLlm('fake'); // 无 toolScript → supportsTools=false
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      strategy: new ToolCallingStrategy({ registry }),
      sessionId: 't',
    });
    const reply = await convo.send('你好', () => {});
    expect(reply).toContain('我在听'); // SingleShot 的 fake stream 占位
  });

  it('空注册表 → 降级回单趟', async () => {
    const llm = new FakeLlm('fake', { toolScript: [{ text: 'x' }] }); // supportsTools=true 但无动作
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      strategy: new ToolCallingStrategy({ registry: new ActionRegistry() }),
      sessionId: 't',
    });
    const reply = await convo.send('你好', () => {});
    expect(reply).toContain('我在听');
  });

  it('工具回合同样落决策 trace', async () => {
    const traces: DecisionTrace[] = [];
    const sink: DecisionTraceSink = { record: (t) => traces.push(t), close: () => {} };
    const registry = new ActionRegistry().register(spyAction('ping', () => {}));
    const llm = new FakeLlm('fake', {
      toolScript: [{ toolCalls: [{ id: 'c1', name: 'ping', input: {} }] }, { text: '好' }],
    });
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      strategy: new ToolCallingStrategy({ registry }),
      traceSink: sink,
      sessionId: 't',
    });
    await convo.send('ping', () => {});
    expect(traces).toHaveLength(1);
    expect(traces[0]?.reply).toBe('好');
    expect(traces[0]?.provider).toBe('fake');
  });
});
