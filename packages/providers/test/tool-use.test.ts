import { describe, it, expect } from 'vitest';
import { FakeLlm, detectToolCallJson } from '../src/index';
import type {
  LlmStreamEvent,
  LlmToolDef,
  LlmToolResponse,
  FakeToolTurn,
} from '../src/index';
import type { ChatMessage, ToolCall } from '@chat-a/protocol';

async function collectEvents(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const recallTool: LlmToolDef = {
  name: 'recall_memory',
  description: '按关键词召回记忆',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  },
};

describe('providers/FakeLlm 工具桩(§3.3)', () => {
  it('completeWithTools 首轮吐 tool_use,停因为 tool_use', async () => {
    const call: ToolCall = { id: 'tc_1', name: 'recall_memory', input: { query: '猫' } };
    const script: FakeToolTurn[] = [{ text: '让我查查……', toolCalls: [call] }, { text: '想起来了,你养了只猫。' }];
    const llm = new FakeLlm('fake-1', { toolScript: script });

    expect(llm.supportsTools).toBe(true);

    const res: LlmToolResponse = await llm.completeWithTools({
      system: 's',
      messages: [{ role: 'user', content: '我养了什么?' }],
      tools: [recallTool],
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]?.id).toBe('tc_1');
    expect(res.toolCalls[0]?.input).toEqual({ query: '猫' });
    expect(res.text).toContain('让我查查');
  });

  it('收到 tool_result 回传后推进到下一轮,续写到 end', async () => {
    const call: ToolCall = { id: 'tc_1', name: 'recall_memory', input: { query: '猫' } };
    const script: FakeToolTurn[] = [{ text: '查询中', toolCalls: [call] }, { text: '你养了只猫。' }];
    const llm = new FakeLlm('fake-1', { toolScript: script });

    // 模拟 Agent loop:user → assistant(tool_use) → tool(tool_result) 回传。
    const messages: ChatMessage[] = [
      { role: 'user', content: '我养了什么?' },
      { role: 'assistant', content: '查询中', toolCalls: [call] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'tc_1', content: '用户养了一只猫' }] },
    ];
    const res = await llm.completeWithTools({ system: 's', messages, tools: [recallTool] });
    expect(res.stopReason).toBe('end');
    expect(res.toolCalls).toHaveLength(0);
    expect(res.text).toContain('你养了只猫');
  });

  it('streamWithTools 先吐文本增量、再吐 tool_use 事件,最后 end', async () => {
    const call: ToolCall = { id: 'tc_x', name: 'recall_memory', input: { query: 'x' } };
    const llm = new FakeLlm('fake-1', { toolScript: [{ text: 'AB', toolCalls: [call] }] });
    const events = await collectEvents(
      llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }] }),
    );
    expect(events).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'tool_use', call },
      { type: 'end', stopReason: 'tool_use' },
    ]);
  });

  it('无脚本时不冒充工具能力,但工具方法退化为回声(无 tool_use)', async () => {
    const llm = new FakeLlm();
    expect(llm.supportsTools).toBe(false);
    const res = await llm.completeWithTools({
      system: '',
      messages: [{ role: 'user', content: '在吗' }],
    });
    expect(res.stopReason).toBe('end');
    expect(res.toolCalls).toHaveLength(0);
    expect(res.text).toContain('在吗');
  });

  it('既有 stream/complete 行为不受工具桩影响(向后兼容)', async () => {
    const llm = new FakeLlm('fake-1', { toolScript: [{ text: '不该出现在 stream' }] });
    let streamed = '';
    for await (const t of llm.stream({ system: '', messages: [{ role: 'user', content: '你好' }] })) {
      streamed += t;
    }
    expect(streamed).toContain('你好');
    expect(streamed).toContain('FakeLLM');
    expect(await llm.complete({ system: '', messages: [{ role: 'user', content: '喵' }] })).toContain('喵');
  });

  it('LlmRequest 可携带 tools/toolChoice 而不报错', async () => {
    const llm = new FakeLlm('fake-1', { toolScript: [{ text: 'ok' }] });
    const res = await llm.completeWithTools({
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      tools: [recallTool],
      toolChoice: { type: 'tool', name: 'recall_memory' },
    });
    expect(res.text).toBe('ok');
  });
});

describe('providers/向后兼容:旧式消息仍合法', () => {
  it('纯 user/assistant 消息(无工具字段)运行级正常', async () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: '三' },
    ];
    const llm = new FakeLlm();
    expect(await llm.complete({ system: '', messages: msgs })).toContain('三');
  });
});

describe('providers/detectToolCallJson(降级备用)', () => {
  it('切出首个完整平衡对象,返回剩余', () => {
    expect(detectToolCallJson('前缀{"name":"a","input":{}}尾巴')).toEqual({
      json: '{"name":"a","input":{}}',
      rest: '尾巴',
    });
  });
  it('字符串内的括号不影响配平', () => {
    expect(detectToolCallJson('{"s":"}{","n":1}')).toEqual({
      json: '{"s":"}{","n":1}',
      rest: '',
    });
  });
  it('转义引号正确处理', () => {
    expect(detectToolCallJson('{"s":"a\\"}b"}')).toEqual({
      json: '{"s":"a\\"}b"}',
      rest: '',
    });
  });
  it('括号未配平时返回 null(等待更多增量)', () => {
    expect(detectToolCallJson('{"name":"a","input":{')).toBeNull();
  });
  it('无 { 返回 null', () => {
    expect(detectToolCallJson('纯文本无对象')).toBeNull();
  });
  it('前置字符串里的 { 不被误锚定,定位到真正的对象', () => {
    // 前缀引号文本含 `{}`,真正对象在其后——锚点必须跳过字符串内的花括号。
    expect(detectToolCallJson('他说"用 {} 格式"然后{"name":"a"}')).toEqual({
      json: '{"name":"a"}',
      rest: '',
    });
  });
  it('只有字符串内 { 没有真实对象 → null', () => {
    expect(detectToolCallJson('"{"x}')).toBeNull();
  });
});
