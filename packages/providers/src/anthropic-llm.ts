import Anthropic from '@anthropic-ai/sdk';
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

export interface AnthropicLlmOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/** Anthropic 文本通道消息(纯 user/assistant + 字符串内容,旧路径形状不变)。 */
interface AnthropicTextMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/** Anthropic `tool` 形态(name/description/input_schema)。 */
interface AnthropicToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

/** Anthropic `tool_choice`(auto/any/tool/none)。 */
type AnthropicToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'any' }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'none' };

/** 工具通道回灌:assistant `tool_use` 块。 */
interface AnthropicToolUseBlock {
  readonly type: 'tool_use';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** 工具通道回灌:user `tool_result` 块。 */
interface AnthropicToolResultBlock {
  readonly type: 'tool_result';
  readonly tool_use_id: string;
  readonly content: string;
  readonly is_error?: boolean;
}

/** 工具通道回灌:`text` 块。 */
interface AnthropicTextBlock {
  readonly type: 'text';
  readonly text: string;
}

type AnthropicToolMessageBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

/** 工具通道消息:content 为块数组(承载 tool_use / tool_result)。 */
interface AnthropicToolMessage {
  readonly role: 'user' | 'assistant';
  readonly content: AnthropicToolMessageBlock[];
}

/** 工具通道请求体形状(messages.create / messages.stream 共用)。 */
interface AnthropicToolRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: AnthropicToolMessage[];
  tools?: AnthropicToolDef[];
  tool_choice?: AnthropicToolChoice;
}

/**
 * 真 Claude Provider(@anthropic-ai/sdk,流式)。模型由配置选(默认 claude-opus-4-8)。
 * 用法依据 claude-api 技能:client.messages.stream + content_block_delta/text_delta。
 *
 * 工具通道(§3.3 模型侧 Anthropic 原生 tool-use,与 OpenAiCompatLlm 对称补齐):
 * supportsTools / completeWithTools / streamWithTools 为**纯加法**可选实现;
 * 纯文本 stream/complete 路径**形状与行为完全不变**。
 */
export class AnthropicLlm implements LlmProvider {
  readonly id = 'anthropic';
  readonly model: string;
  /** Anthropic 原生 tool-use(§3.3);仅供能力驱动/trace,业务不据此分支。 */
  readonly supportsTools = true;
  readonly #client: Anthropic;
  readonly #maxTokens: number;

  constructor(opts: AnthropicLlmOptions) {
    this.model = opts.model;
    this.#maxTokens = opts.maxTokens ?? 1024;
    this.#client = opts.apiKey ? new Anthropic({ apiKey: opts.apiKey }) : new Anthropic();
  }

  async complete(req: LlmRequest, signal?: AbortSignal): Promise<string> {
    // 非流式补全(claude-api 技能:messages.create + 按 type 收 text 块)。短输出场景。
    const msg = await this.#client.messages.create(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? this.#maxTokens,
        system: req.system,
        messages: AnthropicLlm.#toTextMessages(req),
      },
      signal ? { signal } : undefined,
    );
    return msg.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
  }

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const stream = this.#client.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? this.#maxTokens,
        system: req.system,
        messages: AnthropicLlm.#toTextMessages(req),
      },
      signal ? { signal } : undefined,
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }

  // ---- 工具通道(可选,§3.3:Anthropic 原生 tool-use 映射)----
  // 纯文本 stream/complete 路径(上方)完全不动;工具通道用独立的消息映射与请求体。

  async completeWithTools(req: LlmRequest, signal?: AbortSignal): Promise<LlmToolResponse> {
    const msg = await this.#client.messages.create(
      this.#toolRequestBody(req) as unknown as Parameters<Anthropic['messages']['create']>[0],
      signal ? { signal } : undefined,
    );

    // 解析 content 块:text 块拼接为 text;tool_use 块 → ToolCall[]。
    const blocks = (msg as { content?: ReadonlyArray<RespBlock> }).content ?? [];
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const b of blocks) {
      if (b.type === 'text' && typeof b.text === 'string') {
        text += b.text;
      } else if (b.type === 'tool_use') {
        toolCalls.push({ id: b.id ?? '', name: b.name ?? '', input: parseToolInput(b.input) });
      }
    }
    // 停因:聚合出工具调用,或 stop_reason 为 'tool_use' → 'tool_use';否则 'end'(容错降级)。
    const stopReason: LlmStopReason =
      toolCalls.length > 0 || (msg as { stop_reason?: string | null }).stop_reason === 'tool_use'
        ? 'tool_use'
        : 'end';
    return { text, toolCalls, stopReason };
  }

  async *streamWithTools(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent> {
    const stream = this.#client.messages.stream(
      this.#toolRequestBody(req) as unknown as Parameters<Anthropic['messages']['stream']>[0],
      signal ? { signal } : undefined,
    );

    // 工具调用分片按 content 块 index 聚合:content_block_start 记 id/name,
    // input_json_delta 追加 partial_json;同一回合多工具用不同 index 区分。
    const acc = new Map<number, { id: string; name: string; json: string }>();
    const order: number[] = [];

    for await (const event of stream as AsyncIterable<StreamEvent>) {
      if (event.type === 'content_block_start') {
        const blk = event.content_block;
        if (blk?.type === 'tool_use') {
          const idx = event.index ?? 0;
          if (!acc.has(idx)) {
            acc.set(idx, { id: blk.id ?? '', name: blk.name ?? '', json: '' });
            order.push(idx);
          }
        }
      } else if (event.type === 'content_block_delta') {
        const d = event.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          if (d.text) yield { type: 'text', text: d.text };
        } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
          const entry = acc.get(event.index ?? 0);
          if (entry !== undefined) entry.json += d.partial_json;
        }
      }
    }

    // 流结束:按出现顺序逐个 emit 聚合好的 tool_use,再 emit end。
    let emitted = 0;
    for (const idx of order) {
      const entry = acc.get(idx);
      if (entry === undefined) continue;
      const call: ToolCall = { id: entry.id, name: entry.name, input: parseToolInput(entry.json) };
      yield { type: 'tool_use', call };
      emitted++;
    }
    yield { type: 'end', stopReason: emitted > 0 ? 'tool_use' : 'end' };
  }

  /** 工具通道请求体:带 tools / tool_choice / 工具往返消息(纯文本路径不走此处)。 */
  #toolRequestBody(req: LlmRequest): AnthropicToolRequestBody {
    const body: AnthropicToolRequestBody = {
      model: this.model,
      max_tokens: req.maxTokens ?? this.#maxTokens,
      system: req.system,
      messages: AnthropicLlm.#toToolMessages(req),
    };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map(
        (t): AnthropicToolDef => ({
          name: t.name,
          description: t.description,
          input_schema: { ...t.inputSchema },
        }),
      );
    }
    if (req.toolChoice) {
      body.tool_choice = mapToolChoice(req.toolChoice);
    }
    return body;
  }

  /**
   * 纯文本通道(stream/complete)的消息映射:Anthropic 文本 messages 仅接受 user/assistant。
   * 本通道不发起工具调用,'tool' 角色不应出现于此;防御性归并为 'user',保持旧路径形状不变。
   * (工具往返由 completeWithTools/streamWithTools + #toToolMessages 负责。)
   */
  static #toTextMessages(req: LlmRequest): AnthropicTextMessage[] {
    return req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
  }

  /**
   * 工具通道的消息映射:assistant.toolCalls → assistant `tool_use` 块;
   * 'tool' 角色每个 toolResults 项 → user 消息里的 `tool_result` 块(tool_use_id 对齐)。
   * 其余 user/assistant 文本以字符串块包裹。仅工具通道用,纯文本 #toTextMessages 不受影响。
   */
  static #toToolMessages(req: LlmRequest): AnthropicToolMessage[] {
    return req.messages.map((m) => toToolMessage(m));
  }
}

/** response content 块(完成态)最小形状。 */
interface RespBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** Anthropic 流事件最小形状(只取本通道用到的字段)。 */
interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; partial_json?: string };
}

/** 单条 ChatMessage → 一条 Anthropic 工具通道消息(块数组形态)。 */
function toToolMessage(m: ChatMessage): AnthropicToolMessage {
  if (m.role === 'tool') {
    // tool_result 放在 user 回合(Anthropic 约定)。无结构化结果时退化为一条 user 文本块。
    const results = m.toolResults ?? [];
    if (results.length === 0) {
      return { role: 'user', content: [{ type: 'text', text: m.content }] };
    }
    return {
      role: 'user',
      content: results.map(
        (r): AnthropicToolResultBlock => ({
          type: 'tool_result',
          tool_use_id: r.toolCallId,
          content: r.content,
          ...(r.isError ? { is_error: true } : {}),
        }),
      ),
    };
  }
  if (m.role === 'assistant') {
    const calls = m.toolCalls ?? [];
    if (calls.length === 0) {
      return { role: 'assistant', content: [{ type: 'text', text: m.content }] };
    }
    // content 非空时前置 text 块,再附 tool_use 块(空文本则只发 tool_use,避免空 text 块)。
    const blocks: AnthropicToolMessageBlock[] = [];
    if (m.content) blocks.push({ type: 'text', text: m.content });
    for (const c of calls) {
      blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input ?? {} });
    }
    return { role: 'assistant', content: blocks };
  }
  return { role: 'user', content: [{ type: 'text', text: m.content }] };
}

/** LlmToolChoice → Anthropic tool_choice(同名透传,tool 带 name)。 */
function mapToolChoice(choice: LlmToolChoice): AnthropicToolChoice {
  switch (choice.type) {
    case 'auto':
      return { type: 'auto' };
    case 'any':
      return { type: 'any' };
    case 'none':
      return { type: 'none' };
    case 'tool':
      return { type: 'tool', name: choice.name };
  }
}

/**
 * tool_use 块 input → 对象。
 * Anthropic SDK 的 input 已是对象,直接用;若为字符串(流式聚合的 JSON)走 tolerantJsonParse;
 * 空/非法退化为 {}(不抛进回合,§3.2)。
 */
function parseToolInput(input: unknown): unknown {
  if (input === null || input === undefined) return {};
  if (typeof input === 'object') return input;
  if (typeof input === 'string') {
    if (!input.trim()) return {};
    const parsed = tolerantJsonParse(input);
    return parsed ?? {};
  }
  return {};
}
