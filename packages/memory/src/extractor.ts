import type { LlmProvider } from '@chat-a/providers';
import { tolerantJsonParse } from '@chat-a/providers';
import type { MemoryInput } from './types';

/**
 * 记忆抽取接缝(§5.8 写路径来源):回合后从(用户输入 + 回复)抽取 0..N 条要点/偏好。
 * 返回待写入项(由调用方 addMemory,复用 ADD+去重);不直接写库,便于测试与替换(§3.1)。
 */
export interface MemoryExtractor {
  extract(userText: string, reply: string): Promise<readonly MemoryInput[]>;
}

/** 默认:不抽取(保持既有 naive 写入来源)。 */
export class NoopMemoryExtractor implements MemoryExtractor {
  async extract(_userText: string, _reply: string): Promise<readonly MemoryInput[]> {
    return [];
  }
}

export interface LlmMemoryExtractorOptions {
  readonly provider: LlmProvider;
  readonly maxTokens?: number;
  /** 单轮最多抽取条数(防失控)。 */
  readonly maxItems?: number;
  readonly onError?: (err: unknown) => void;
}

function buildPrompt(userText: string, reply: string): string {
  return [
    '从下面这轮对话里,抽取关于「用户」的值得长期记住的事实/偏好(姓名、喜好、计划、重要近况等)。',
    '没有则返回空数组。只输出 JSON 数组,每项形如 {"text":"用户叫小明"}。简洁、第三人称陈述。',
    `用户说:「${userText}」`,
    `回复:「${reply}」`,
  ].join('\n');
}

/** 把解析结果校验为 MemoryInput[](丢弃非法项)。 */
function toItems(v: unknown, maxItems: number): MemoryInput[] {
  if (!Array.isArray(v)) return [];
  const out: MemoryInput[] = [];
  for (const raw of v) {
    if (out.length >= maxItems) break;
    const text = typeof raw === 'string' ? raw : isRecord(raw) && typeof raw['text'] === 'string' ? raw['text'] : undefined;
    if (text !== undefined && text.trim().length > 0) {
      out.push({ text: text.trim(), kind: 'extracted' });
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * LLM 记忆抽取:complete + 要 JSON 数组 + 容错解析。失败返回 [](跳过本轮,不打断回合,§3.2)。
 */
export class LlmMemoryExtractor implements MemoryExtractor {
  readonly #provider: LlmProvider;
  readonly #maxTokens: number;
  readonly #maxItems: number;
  readonly #onError: ((err: unknown) => void) | undefined;

  constructor(opts: LlmMemoryExtractorOptions) {
    this.#provider = opts.provider;
    this.#maxTokens = opts.maxTokens ?? 256;
    this.#maxItems = opts.maxItems ?? 5;
    this.#onError = opts.onError;
  }

  async extract(userText: string, reply: string): Promise<readonly MemoryInput[]> {
    try {
      const text = await this.#provider.complete({
        system: '你是记忆抽取器,只输出 JSON 数组,不要解释。',
        messages: [{ role: 'user', content: buildPrompt(userText, reply) }],
        maxTokens: this.#maxTokens,
      });
      return toItems(tolerantJsonParse(text), this.#maxItems);
    } catch (err) {
      this.#onError?.(err);
      return [];
    }
  }
}
