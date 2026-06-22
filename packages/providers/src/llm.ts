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
  /** provider 标识(如 'anthropic')——**仅供 trace/日志**(§8.1),业务逻辑不得据此分支。 */
  readonly id: string;
  /** 当前模型串——**仅供 trace/日志**,系统对具体模型无感。 */
  readonly model: string;
  /** 流式输出文本增量。 */
  stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string>;
  /**
   * 非流式补全:返回完整文本(用于情绪评估/记忆抽取等"要 JSON"的短调用)。
   * 仍厂商无感;调用方据提示约定 JSON,再用 tolerantJsonParse 容错解析。
   */
  complete(req: LlmRequest, signal?: AbortSignal): Promise<string>;
}
