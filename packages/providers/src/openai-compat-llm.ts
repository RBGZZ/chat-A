import type { ChatMessage, ToolCall } from '@chat-a/protocol';
import type {
  LlmProvider,
  LlmRequest,
  LlmStopReason,
  LlmStreamEvent,
  LlmToolChoice,
  LlmToolResponse,
} from './llm';
import { tolerantJsonParse } from './json';

/** OpenAI function-calling 请求里 tools 的形状。 */
interface OpenAiToolDef {
  readonly type: 'function';
  readonly function: { name: string; description: string; parameters: Record<string, unknown> };
}

/** OpenAI tool_choice 的形状(字符串或指定 function)。 */
type OpenAiToolChoice = 'auto' | 'required' | 'none' | { type: 'function'; function: { name: string } };

/** 回灌给端点的 OpenAI 消息(工具通道用,可携带 tool_calls / tool_call_id)。 */
interface OpenAiToolMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/** 非流式响应里 message.tool_calls 的形状。 */
interface OpenAiRespToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface OpenAiCompatLlmOptions {
  /** provider 标识(如 'deepseek')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.deepseek.com'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  readonly maxTokens?: number;
}

/**
 * OpenAI 兼容协议 Provider(POST /chat/completions,SSE 流式)。
 * DeepSeek / 月之暗面 / 通义 等"OpenAI 兼容"端点皆可复用——换 baseURL + model + key 即可,
 * 系统对具体厂商无感(§3.3);id/model 仅供 trace。用原生 fetch,无第三方依赖。
 */
export class OpenAiCompatLlm implements LlmProvider {
  readonly id: string;
  readonly model: string;
  /** OpenAI 兼容端点支持 function calling(§3.3);仅供能力驱动/trace,业务不据此分支。 */
  readonly supportsTools = true;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #maxTokens: number;

  constructor(opts: OpenAiCompatLlmOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#maxTokens = opts.maxTokens ?? 1024;
  }

  #buildMessages(req: LlmRequest): Array<{ role: string; content: string }> {
    return [
      ...(req.system ? [{ role: 'system', content: req.system }] : []),
      // 文本通道只走 user/assistant;工具往返('tool' 角色)由 *WithTools 通道处理,
      // 这里把非 assistant(含 'tool')归并为 user,避免发出缺 tool_call_id 的 tool 消息(与 anthropic 实现对称)。
      ...req.messages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ];
  }

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<string> {
    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.model,
        messages: this.#buildMessages(req),
        stream: false,
        max_tokens: req.maxTokens ?? this.#maxTokens,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
    const data = (await res.json()) as { choices?: ReadonlyArray<{ message?: { content?: string | null } }> };
    return data.choices?.[0]?.message?.content ?? '';
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const messages = this.#buildMessages(req);

    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        max_tokens: req.maxTokens ?? this.#maxTokens,
      }),
      ...(signal ? { signal } : {}),
    });

    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }

    // SSE:逐行解析 `data: {json}`,以 `data: [DONE]` 收尾。TextDecoder(stream) 处理跨块 UTF-8。
    const decoder = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (data === '[DONE]') return;
        const token = extractDelta(data);
        if (token) yield token;
      }
    }
  }

  // ---- 工具通道(可选,§3.3:OpenAI function calling 映射)----
  // 纯文本 stream/complete 路径(上方)完全不动;工具通道用独立的消息映射与请求体。

  async completeWithTools(req: LlmRequest, signal?: AbortSignal): Promise<LlmToolResponse> {
    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(this.#toolRequestBody(req, false)),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }
    const data = (await res.json()) as {
      choices?: ReadonlyArray<{
        message?: { content?: string | null; tool_calls?: readonly OpenAiRespToolCall[] | null };
        finish_reason?: string | null;
      }>;
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? '';
    const toolCalls = mapRespToolCalls(choice?.message?.tool_calls ?? null);
    // 停因:聚合出工具调用即 'tool_use';否则参考 finish_reason,默认 'end'(容错降级)。
    const stopReason: LlmStopReason =
      toolCalls.length > 0 || choice?.finish_reason === 'tool_calls' ? 'tool_use' : 'end';
    return { text, toolCalls, stopReason };
  }

  async *streamWithTools(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const res = await fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify(this.#toolRequestBody(req, true)),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }

    // 工具调用分片按 index 聚合(同一调用跨多个 chunk 用同 index;首片带 id/name,后续片追加 arguments)。
    const acc = new Map<number, { id: string; name: string; args: string }>();
    const order: number[] = [];

    const decoder = new TextDecoder();
    let buf = '';
    let done = false;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice('data:'.length).trim();
        if (data === '[DONE]') {
          done = true;
          break;
        }
        const delta = parseStreamDelta(data);
        if (delta === undefined) continue; // 单片解析失败:跳过,不中断流。
        if (delta.content) yield { type: 'text', text: delta.content };
        for (const tc of delta.toolCalls) {
          let entry = acc.get(tc.index);
          if (entry === undefined) {
            entry = { id: tc.id ?? '', name: tc.name ?? '', args: '' };
            acc.set(tc.index, entry);
            order.push(tc.index);
          }
          if (tc.id) entry.id = tc.id;
          if (tc.name) entry.name = tc.name;
          if (tc.args) entry.args += tc.args;
        }
      }
      if (done) break;
    }

    // 流结束:逐个 emit 聚合好的 tool_use,再 emit end(有工具→'tool_use' 否则 'end')。
    let emitted = 0;
    for (const idx of order) {
      const entry = acc.get(idx);
      if (entry === undefined) continue;
      const call: ToolCall = { id: entry.id, name: entry.name, input: parseArguments(entry.args) };
      yield { type: 'tool_use', call };
      emitted++;
    }
    yield { type: 'end', stopReason: emitted > 0 ? 'tool_use' : 'end' };
  }

  /** 工具通道请求体:带 tools / tool_choice / 工具往返消息(纯文本路径不走此处)。 */
  #toolRequestBody(req: LlmRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: this.#buildToolMessages(req),
      stream,
      max_tokens: req.maxTokens ?? this.#maxTokens,
    };
    if (req.tools && req.tools.length > 0) {
      body['tools'] = req.tools.map(
        (t): OpenAiToolDef => ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: { ...t.inputSchema } },
        }),
      );
    }
    if (req.toolChoice) {
      body['tool_choice'] = mapToolChoice(req.toolChoice);
    }
    return body;
  }

  /**
   * 工具通道的消息映射:assistant.toolCalls → OpenAI assistant tool_calls;
   * 'tool' 角色每个 toolResults 项 → 一条 { role:'tool', tool_call_id, content } 消息。
   * 其余 user/assistant 文本照旧。仅工具通道用,纯文本 #buildMessages 不受影响。
   */
  #buildToolMessages(req: LlmRequest): OpenAiToolMessage[] {
    const out: OpenAiToolMessage[] = [];
    if (req.system) out.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      out.push(...toOpenAiToolMessages(m));
    }
    return out;
  }
}

/** 单条 ChatMessage → 0..N 条 OpenAI 工具通道消息。 */
function toOpenAiToolMessages(m: ChatMessage): OpenAiToolMessage[] {
  if (m.role === 'tool') {
    const results = m.toolResults ?? [];
    if (results.length === 0) {
      // 无结构化结果:退化为一条无 id 的 tool 文本(尽量保住内容,不丢上下文)。
      return [{ role: 'tool', content: m.content }];
    }
    return results.map((r) => ({ role: 'tool', content: r.content, tool_call_id: r.toolCallId }));
  }
  if (m.role === 'assistant') {
    const calls = m.toolCalls ?? [];
    if (calls.length === 0) return [{ role: 'assistant', content: m.content }];
    return [
      {
        role: 'assistant',
        content: m.content,
        tool_calls: calls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        })),
      },
    ];
  }
  return [{ role: 'user', content: m.content }];
}

/** LlmToolChoice → OpenAI tool_choice(any→'required',tool→指定 function)。 */
function mapToolChoice(choice: LlmToolChoice): OpenAiToolChoice {
  switch (choice.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: choice.name } };
  }
}

/** 非流式响应 message.tool_calls → ToolCall[](arguments 用 tolerantJsonParse 容错)。 */
function mapRespToolCalls(raw: readonly OpenAiRespToolCall[] | null): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((tc) => ({
    id: tc.id ?? '',
    name: tc.function?.name ?? '',
    input: parseArguments(tc.function?.arguments ?? ''),
  }));
}

/** OpenAI arguments(JSON 字符串)→ 对象;空/非法退化为 {}(不抛进回合,§3.2)。 */
function parseArguments(args: string): unknown {
  if (!args.trim()) return {};
  const parsed = tolerantJsonParse(args);
  return parsed ?? {};
}

/** 解析单个流式 chunk 的 delta:content 增量 + tool_calls 分片(按 index)。 */
function parseStreamDelta(
  data: string,
): { content: string; toolCalls: Array<{ index: number; id?: string; name?: string; args?: string }> } | undefined {
  try {
    const parsed = JSON.parse(data) as {
      choices?: ReadonlyArray<{
        delta?: {
          content?: string | null;
          tool_calls?: ReadonlyArray<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }> | null;
        };
      }>;
    };
    const delta = parsed.choices?.[0]?.delta;
    const toolCalls: Array<{ index: number; id?: string; name?: string; args?: string }> = [];
    for (const tc of delta?.tool_calls ?? []) {
      const piece: { index: number; id?: string; name?: string; args?: string } = { index: tc.index ?? 0 };
      if (tc.id !== undefined && tc.id !== null) piece.id = tc.id;
      if (tc.function?.name !== undefined && tc.function?.name !== null) piece.name = tc.function.name;
      if (tc.function?.arguments !== undefined && tc.function?.arguments !== null) piece.args = tc.function.arguments;
      toolCalls.push(piece);
    }
    return { content: delta?.content ?? '', toolCalls };
  } catch {
    return undefined;
  }
}

function extractDelta(data: string): string | undefined {
  try {
    const parsed = JSON.parse(data) as {
      choices?: ReadonlyArray<{ delta?: { content?: string | null } }>;
    };
    const content = parsed.choices?.[0]?.delta?.content;
    return content ?? undefined;
  } catch {
    return undefined;
  }
}
