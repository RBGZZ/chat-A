import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock @anthropic-ai/sdk:默认导出 Anthropic 类,实例的 messages.create/stream 为可控 vi.fn。
// 通过模块级 hooks 在每个用例里设定返回值并捕获请求体(模拟 Anthropic 响应/SSE,不发真请求)。
const hooks = {
  create: vi.fn(),
  stream: vi.fn(),
};

vi.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    messages = {
      create: (...args: unknown[]) => hooks.create(...args),
      stream: (...args: unknown[]) => hooks.stream(...args),
    };
    constructor(_opts?: unknown) {}
  }
  return { default: FakeAnthropic };
});

// 在 mock 之后导入被测类(确保拿到 mock 过的 SDK)。
const { AnthropicLlm } = await import('../src/anthropic-llm');
const importedTypes = await import('../src/index');
type LlmStreamEvent = import('../src/index').LlmStreamEvent;
type LlmToolDef = import('../src/index').LlmToolDef;
type ChatMessage = import('@chat-a/protocol').ChatMessage;
void importedTypes;

/** 设定 messages.create 的返回(模拟完成态 Message),并捕获请求体。 */
function onCreate(message: unknown): { last: () => any } {
  const captured: { value?: any } = {};
  hooks.create.mockImplementation(async (body: any) => {
    captured.value = body;
    return message;
  });
  return { last: () => captured.value };
}

/** 设定 messages.stream 的返回(模拟 SSE 事件异步可迭代),并捕获请求体。 */
function onStream(events: unknown[]): { last: () => any } {
  const captured: { value?: any } = {};
  hooks.stream.mockImplementation((body: any) => {
    captured.value = body;
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    };
  });
  return { last: () => captured.value };
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const llm = new AnthropicLlm({ model: 'claude-opus-4-8', apiKey: 'sk-test' });

const recallTool: LlmToolDef = {
  name: 'recall_memory',
  description: '按关键词召回记忆',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

beforeEach(() => {
  hooks.create.mockReset();
  hooks.stream.mockReset();
});

describe('AnthropicLlm/工具能力声明', () => {
  it('supportsTools 为 true', () => {
    expect(llm.supportsTools).toBe(true);
  });
});

describe('AnthropicLlm/completeWithTools', () => {
  it('返回 tool_use 块 → 解析为 ToolCall + stopReason tool_use,text 取 text 块拼接', async () => {
    const cap = onCreate({
      content: [
        { type: 'text', text: '让我查查' },
        { type: 'tool_use', id: 'toolu_1', name: 'recall_memory', input: { query: '猫' } },
      ],
      stop_reason: 'tool_use',
    });
    const res = await llm.completeWithTools({
      system: 's',
      messages: [{ role: 'user', content: '我养了什么?' }],
      tools: [recallTool],
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.text).toBe('让我查查');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({ id: 'toolu_1', name: 'recall_memory', input: { query: '猫' } });

    // 请求体带 Anthropic tools 形态(name/description/input_schema)。
    const body = cap.last();
    expect(body.tools[0]).toEqual({
      name: 'recall_memory',
      description: '按关键词召回记忆',
      input_schema: recallTool.inputSchema,
    });
    expect(body.system).toBe('s');
  });

  it('input 为非法 JSON 字符串 → 退化为 {} 不抛', async () => {
    onCreate({
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'f', input: '{不是json' }],
      stop_reason: 'tool_use',
    });
    const res = await llm.completeWithTools({
      system: '',
      messages: [{ role: 'user', content: 'x' }],
      tools: [recallTool],
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls[0]?.input).toEqual({});
  });

  it('无 tool_use → 纯文本 end(容错降级)', async () => {
    onCreate({ content: [{ type: 'text', text: '你好呀' }], stop_reason: 'end_turn' });
    const res = await llm.completeWithTools({
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [recallTool],
    });
    expect(res.stopReason).toBe('end');
    expect(res.toolCalls).toHaveLength(0);
    expect(res.text).toBe('你好呀');
  });
});

describe('AnthropicLlm/streamWithTools', () => {
  it('text_delta + 跨事件 input_json_delta 聚合 → text + 聚合 tool_use + end', async () => {
    const cap = onStream([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_9', name: 'recall_memory' },
      },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"que' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'ry":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ]);
    const events = await collect(
      llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }], tools: [recallTool] }),
    );
    expect(events).toEqual([
      { type: 'text', text: '好' },
      { type: 'tool_use', call: { id: 'toolu_9', name: 'recall_memory', input: { query: 'x' } } },
      { type: 'end', stopReason: 'tool_use' },
    ]);
    expect(cap.last().tools[0].name).toBe('recall_memory');
  });

  it('纯文本流 → text + end(end)', async () => {
    onStream([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'A' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'B' } },
      { type: 'content_block_stop', index: 0 },
    ]);
    const events = await collect(llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'end', stopReason: 'end' },
    ]);
  });

  it('input_json_delta 为空/非法 → input 退化 {}', async () => {
    onStream([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_3', name: 'f' },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{坏' } },
    ]);
    const events = await collect(
      llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [recallTool] }),
    );
    expect(events).toEqual([
      { type: 'tool_use', call: { id: 'toolu_3', name: 'f', input: {} } },
      { type: 'end', stopReason: 'tool_use' },
    ]);
  });
});

describe('AnthropicLlm/tool_choice 映射', () => {
  const cases: Array<[any, any]> = [
    [{ type: 'auto' }, { type: 'auto' }],
    [{ type: 'any' }, { type: 'any' }],
    [{ type: 'none' }, { type: 'none' }],
    [{ type: 'tool', name: 'recall_memory' }, { type: 'tool', name: 'recall_memory' }],
  ];
  for (const [choice, expected] of cases) {
    it(`${JSON.stringify(choice)} → ${JSON.stringify(expected)}`, async () => {
      const cap = onCreate({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' });
      await llm.completeWithTools({
        system: '',
        messages: [{ role: 'user', content: 'x' }],
        tools: [recallTool],
        toolChoice: choice,
      });
      expect(cap.last().tool_choice).toEqual(expected);
    });
  }

  it('未提供 toolChoice 时请求体不含该字段', async () => {
    const cap = onCreate({ content: [{ type: 'text', text: '' }], stop_reason: 'end_turn' });
    await llm.completeWithTools({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [recallTool] });
    expect(cap.last()).not.toHaveProperty('tool_choice');
  });
});

describe('AnthropicLlm/工具往返消息回灌', () => {
  it('assistant.toolCalls → tool_use 块;tool.toolResults → user tool_result 块,tool_use_id 对齐', async () => {
    const cap = onCreate({ content: [{ type: 'text', text: '你养了只猫' }], stop_reason: 'end_turn' });
    const messages: ChatMessage[] = [
      { role: 'user', content: '我养了什么?' },
      { role: 'assistant', content: '查询中', toolCalls: [{ id: 'toolu_1', name: 'recall_memory', input: { query: '猫' } }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'toolu_1', content: '用户养了一只猫' }] },
    ];
    const res = await llm.completeWithTools({ system: 's', messages, tools: [recallTool] });
    expect(res.text).toBe('你养了只猫');

    const sent = cap.last().messages;
    expect(sent[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '我养了什么?' }] });
    expect(sent[1]).toEqual({
      role: 'assistant',
      content: [
        { type: 'text', text: '查询中' },
        { type: 'tool_use', id: 'toolu_1', name: 'recall_memory', input: { query: '猫' } },
      ],
    });
    expect(sent[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '用户养了一只猫' }],
    });
  });

  it('isError 结果带 is_error;空文本 assistant 只发 tool_use 块', async () => {
    const cap = onCreate({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' });
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_e', name: 'f', input: {} }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'toolu_e', content: '炸了', isError: true }] },
    ];
    await llm.completeWithTools({ system: '', messages, tools: [recallTool] });
    const sent = cap.last().messages;
    expect(sent[0]).toEqual({ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_e', name: 'f', input: {} }] });
    expect(sent[1]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu_e', content: '炸了', is_error: true }],
    });
  });
});

describe('AnthropicLlm/向后兼容:纯文本路径不变', () => {
  it('complete 请求体不含 tools/tool_choice,消息为 user/assistant 字符串,tool 角色归并为 user', async () => {
    const cap = onCreate({ content: [{ type: 'text', text: '回复' }], stop_reason: 'end_turn' });
    const messages: ChatMessage[] = [
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二', toolCalls: [{ id: 'x', name: 'f', input: {} }] },
      { role: 'tool', content: 'r', toolResults: [{ toolCallId: 'x', content: 'r' }] },
    ];
    const out = await llm.complete({ system: 's', messages, tools: [recallTool], toolChoice: { type: 'any' } });
    expect(out).toBe('回复');
    const body = cap.last();
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
    // 纯文本映射:tool 角色归并为 user 字符串,assistant 不带 tool_use 块。
    expect(body.messages).toEqual([
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: 'r' },
    ]);
  });

  it('stream 仍逐 token 产出纯文本', async () => {
    onStream([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '喵' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '呜' } },
    ]);
    let s = '';
    for await (const t of llm.stream({ system: '', messages: [{ role: 'user', content: 'hi' }] })) s += t;
    expect(s).toBe('喵呜');
  });
});
