import type { ChatMessage, ToolCall } from '@chat-a/protocol';

/**
 * LLM Provider 接缝(承 §3.3 能力驱动 + §4 流式贯穿全链)。
 * 业务层只依赖此接口;换模型 = 换实现 + 改配置,回合逻辑不动(§3.1)。
 */
export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  /** 工具定义(§3.3 模型侧 Anthropic 原生 tool-use);不带时与现状等价,纯加法。 */
  readonly tools?: readonly LlmToolDef[];
  /** 工具选择策略;默认由实现决定(通常等价 auto)。 */
  readonly toolChoice?: LlmToolChoice;
}

/** 工具定义——映射 Anthropic `tool`(name/description/input_schema)。 */
export interface LlmToolDef {
  readonly name: string;
  readonly description: string;
  /** 入参 JSON schema(映射 Anthropic `input_schema`)。 */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 工具选择策略——映射 Anthropic `tool_choice`。 */
export type LlmToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'any' }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'none' };

/** 工具通道为何停:模型自然收尾('end')或决定调工具('tool_use')。 */
export type LlmStopReason = 'end' | 'tool_use';

/** 非流式工具补全的聚合结果。 */
export interface LlmToolResponse {
  /** 拼好的文本(可空——纯工具调用回合)。 */
  readonly text: string;
  /** 本轮模型发起的工具调用(0..N)。 */
  readonly toolCalls: readonly ToolCall[];
  readonly stopReason: LlmStopReason;
}

/** 流式工具通道的事件(判别联合,承 §4 流式贯穿)。 */
export type LlmStreamEvent =
  /** 文本增量(等价旧 stream 的 token)。 */
  | { readonly type: 'text'; readonly text: string }
  /** 模型发起一个工具调用。 */
  | { readonly type: 'tool_use'; readonly call: ToolCall }
  /** 本轮结束,带停因。 */
  | { readonly type: 'end'; readonly stopReason: LlmStopReason };

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
  /**
   * 工具能力标志(§3.3)——**仅供能力驱动/调度**,业务逻辑不得据 provider id 分支。
   * 不声明视为"不支持工具通道"。
   */
  readonly supportsTools?: boolean;
  /**
   * 非流式工具补全(可选新通道):返回文本 + tool_use 调用 + 停因。
   * **既有 complete 不变**;不支持工具的 Provider 不实现此方法即可。
   */
  completeWithTools?(req: LlmRequest, signal?: AbortSignal): Promise<LlmToolResponse>;
  /**
   * 流式工具通道(可选新通道):yield 文本增量 + tool_use 事件 + 结束事件。
   * **既有 stream(token)=>string 不变**;为未来 Agent loop 铺路。
   */
  streamWithTools?(req: LlmRequest, signal?: AbortSignal): AsyncIterable<LlmStreamEvent>;
}
