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

  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const stream = this.#client.messages.stream(
      {
        model: this.model,
        max_tokens: req.maxTokens ?? this.#maxTokens,
        system: req.system,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      },
      signal ? { signal } : undefined,
    );
    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield event.delta.text;
      }
    }
  }
}
