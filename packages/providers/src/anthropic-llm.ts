import Anthropic from '@anthropic-ai/sdk';
import type { LlmProvider, LlmRequest } from './llm';

export interface AnthropicLlmOptions {
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/**
 * 真 Claude Provider(@anthropic-ai/sdk,流式)。模型由配置选(默认 claude-opus-4-8)。
 * 用法依据 claude-api 技能:client.messages.stream + content_block_delta/text_delta。
 */
export class AnthropicLlm implements LlmProvider {
  readonly id = 'anthropic';
  readonly model: string;
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

  /**
   * 纯文本通道(stream/complete)的消息映射:Anthropic 文本 messages 仅接受 user/assistant。
   * 本通道不发起工具调用,'tool' 角色不应出现于此;防御性归并为 'user',保持旧路径形状不变。
   * (工具往返由 completeWithTools/streamWithTools 负责,本切片仅在 FakeLlm 落地。)
   */
  static #toTextMessages(req: LlmRequest): Array<{ role: 'user' | 'assistant'; content: string }> {
    return req.messages.map((m) => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }));
  }
}
