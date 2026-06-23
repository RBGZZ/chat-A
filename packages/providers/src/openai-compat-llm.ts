import type { LlmProvider, LlmRequest } from './llm';

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
