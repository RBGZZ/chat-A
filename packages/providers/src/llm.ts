import type { ChatMessage } from '@chat-a/protocol';

/**
 * LLM Provider 接缝(承 §3.3 能力驱动 + §4 流式贯穿全链)。
 * 业务层只依赖此接口;换模型 = 换实现 + 改配置,回合逻辑不动(§3.1)。
 */
export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
}

export interface LlmProvider {
  /** provider 标识(如 'anthropic' / 'fake')。 */
  readonly id: string;
  /** 当前模型串。 */
  readonly model: string;
  /** 流式输出文本增量。 */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string>;
}
