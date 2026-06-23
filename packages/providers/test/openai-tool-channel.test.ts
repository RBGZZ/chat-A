import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiCompatLlm } from '../src/index';
import type { LlmStreamEvent, LlmToolDef } from '../src/index';
import type { ChatMessage } from '@chat-a/protocol';

/** 构造一个 mock fetch:返回给定 JSON(非流式)。同时捕获最后一次请求体供断言。 */
function mockJson(body: unknown): { last: () => any } {
  const captured: { value?: any } = {};
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    captured.value = init?.body ? JSON.parse(init.body as string) : undefined;
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { last: () => captured.value };
}

/** 构造一个 mock fetch:把若干 SSE 行作为字节流 body 返回(流式)。 */
function mockSse(lines: string[]): { last: () => any } {
  const captured: { value?: any } = {};
  const enc = new TextEncoder();
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    captured.value = init?.body ? JSON.parse(init.body as string) : undefined;
    const body = {
      async *[Symbol.asyncIterator]() {
        for (const l of lines) yield enc.encode(l);
      },
    };
    return { ok: true, status: 200, statusText: 'OK', body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { last: () => captured.value };
}

async function collect(stream: AsyncIterable<LlmStreamEvent>): Promise<LlmStreamEvent[]> {
  const out: LlmStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const llm = new OpenAiCompatLlm({
  id: 'deepseek',
  model: 'deepseek-chat',
  apiKey: 'k',
  baseURL: 'https://api.example.com/',
});

const recallTool: LlmToolDef = {
  name: 'recall_memory',
  description: '按关键词召回记忆',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatLlm/工具能力声明', () => {
  it('supportsTools 为 true', () => {
    expect(llm.supportsTools).toBe(true);
  });
});

describe('OpenAiCompatLlm/completeWithTools', () => {
  it('返回 tool_calls → 解析为 ToolCall + stopReason tool_use', async () => {
    const cap = mockJson({
      choices: [
        {
          message: {
            content: '让我查查',
            tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'recall_memory', arguments: '{"query":"猫"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const res = await llm.completeWithTools({
      system: 's',
      messages: [{ role: 'user', content: '我养了什么?' }],
      tools: [recallTool],
    });
    expect(res.stopReason).toBe('tool_use');
    expect(res.text).toBe('让我查查');
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]).toEqual({ id: 'call_1', name: 'recall_memory', input: { query: '猫' } });

    // 请求体带 OpenAI function 格式 tools。
    const body = cap.last();
    expect(body.tools[0]).toEqual({
      type: 'function',
      function: { name: 'recall_memory', description: '按关键词召回记忆', parameters: recallTool.inputSchema },
    });
    expect(body.stream).toBe(false);
  });

  it('arguments 非法 JSON → input 退化为 {} 不抛', async () => {
    mockJson({
      choices: [
        {
          message: { content: '', tool_calls: [{ id: 'c', function: { name: 'f', arguments: '{不是json' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    });
    const res = await llm.completeWithTools({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [recallTool] });
    expect(res.stopReason).toBe('tool_use');
    expect(res.toolCalls[0]?.input).toEqual({});
  });

  it('无 tool_calls → 纯文本 end(容错降级)', async () => {
    mockJson({ choices: [{ message: { content: '你好呀' }, finish_reason: 'stop' }] });
    const res = await llm.completeWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }], tools: [recallTool] });
    expect(res.stopReason).toBe('end');
    expect(res.toolCalls).toHaveLength(0);
    expect(res.text).toBe('你好呀');
  });
});

describe('OpenAiCompatLlm/streamWithTools', () => {
  it('文本片 + 跨 chunk 同 index 工具分片 → text + 聚合 tool_use + end', async () => {
    const cap = mockSse([
      'data: {"choices":[{"delta":{"content":"好"}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_9","function":{"name":"recall_memory","arguments":"{\\"que"}}]}}]}\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"x\\"}"}}]}}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(
      llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }], tools: [recallTool] }),
    );
    expect(events).toEqual([
      { type: 'text', text: '好' },
      { type: 'tool_use', call: { id: 'call_9', name: 'recall_memory', input: { query: 'x' } } },
      { type: 'end', stopReason: 'tool_use' },
    ]);
    expect(cap.last().stream).toBe(true);
  });

  it('纯文本流 → text + end(end)', async () => {
    mockSse([
      'data: {"choices":[{"delta":{"content":"A"}}]}\n',
      'data: {"choices":[{"delta":{"content":"B"}}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual([
      { type: 'text', text: 'A' },
      { type: 'text', text: 'B' },
      { type: 'end', stopReason: 'end' },
    ]);
  });

  it('单片解析失败被跳过,不中断流', async () => {
    mockSse([
      'data: {不是json}\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n',
      'data: [DONE]\n',
    ]);
    const events = await collect(llm.streamWithTools({ system: '', messages: [{ role: 'user', content: 'hi' }] }));
    expect(events).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'end', stopReason: 'end' },
    ]);
  });
});

describe('OpenAiCompatLlm/tool_choice 映射', () => {
  const cases: Array<[any, any]> = [
    [{ type: 'auto' }, 'auto'],
    [{ type: 'any' }, 'required'],
    [{ type: 'none' }, 'none'],
    [{ type: 'tool', name: 'recall_memory' }, { type: 'function', function: { name: 'recall_memory' } }],
  ];
  for (const [choice, expected] of cases) {
    it(`${JSON.stringify(choice)} → ${JSON.stringify(expected)}`, async () => {
      const cap = mockJson({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
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
    const cap = mockJson({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
    await llm.completeWithTools({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [recallTool] });
    expect(cap.last()).not.toHaveProperty('tool_choice');
  });
});

describe('OpenAiCompatLlm/工具往返消息回灌', () => {
  it('assistant.toolCalls / tool.toolResults → OpenAI tool_calls + role:tool,tool_call_id', async () => {
    const cap = mockJson({ choices: [{ message: { content: '你养了只猫' }, finish_reason: 'stop' }] });
    const messages: ChatMessage[] = [
      { role: 'user', content: '我养了什么?' },
      { role: 'assistant', content: '查询中', toolCalls: [{ id: 'call_1', name: 'recall_memory', input: { query: '猫' } }] },
      { role: 'tool', content: '', toolResults: [{ toolCallId: 'call_1', content: '用户养了一只猫' }] },
    ];
    const res = await llm.completeWithTools({ system: 's', messages, tools: [recallTool] });
    expect(res.text).toBe('你养了只猫');

    const sent = cap.last().messages;
    // system + user + assistant(tool_calls) + tool(tool_call_id)
    expect(sent[0]).toEqual({ role: 'system', content: 's' });
    expect(sent[1]).toEqual({ role: 'user', content: '我养了什么?' });
    expect(sent[2]).toEqual({
      role: 'assistant',
      content: '查询中',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'recall_memory', arguments: '{"query":"猫"}' } }],
    });
    expect(sent[3]).toEqual({ role: 'tool', content: '用户养了一只猫', tool_call_id: 'call_1' });
  });
});

describe('OpenAiCompatLlm/向后兼容:纯文本路径不变', () => {
  it('complete 请求体不含 tools/tool_choice/tool_calls,且 tool 角色归并为 user', async () => {
    const cap = mockJson({ choices: [{ message: { content: '回复' } }] });
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
    // 纯文本映射:tool 角色归并为 user,assistant 不带 tool_calls。
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: '一' },
      { role: 'assistant', content: '二' },
      { role: 'user', content: 'r' },
    ]);
  });

  it('stream 仍逐 token 产出纯文本', async () => {
    mockSse([
      'data: {"choices":[{"delta":{"content":"喵"}}]}\n',
      'data: {"choices":[{"delta":{"content":"呜"}}]}\n',
      'data: [DONE]\n',
    ]);
    let s = '';
    for await (const t of llm.stream({ system: '', messages: [{ role: 'user', content: 'hi' }] })) s += t;
    expect(s).toBe('喵呜');
  });
});
