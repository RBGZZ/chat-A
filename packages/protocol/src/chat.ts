/** 跨模块共享的对话消息类型(cognition 历史与 providers 请求共用,§3.1)。 */
//
// 工具调用为**纯加法**(§3.3 模型侧 Anthropic 原生 tool-use):
// `content: string` 与既有 user/assistant 消息语义**完全不变**,新增字段全部可选;
// 角色由二元扩为三元(加 'tool',旧两值不变),仅消费 `.role`/`.content` 的旧代码零改动仍编译。
export type ChatRole = 'user' | 'assistant' | 'tool';

/** assistant 发起的工具调用(承 Anthropic `tool_use` 块)。 */
export interface ToolCall {
  /** tool_use_id——回传 tool_result 时据此对齐(= ToolResult.toolCallId)。 */
  readonly id: string;
  readonly name: string;
  /** 已解析的入参对象(JSON);形态由对应工具的 input schema 决定。 */
  readonly input: unknown;
}

/** 回传给模型的工具结果(承 Anthropic `tool_result` 块)。 */
export interface ToolResult {
  /** 对应的 ToolCall.id。 */
  readonly toolCallId: string;
  readonly content: string;
  /** 工具执行失败时置 true,供模型据此调整(默认无 = 成功)。 */
  readonly isError?: boolean;
}

export interface ChatMessage {
  readonly role: ChatRole;
  /** **不变**:user/assistant 的文本内容;'tool' 角色可为 "" 或人类可读摘要。 */
  readonly content: string;
  /** 仅 assistant 用——本轮模型发起的工具调用(纯加法,可选)。 */
  readonly toolCalls?: readonly ToolCall[];
  /** 仅 'tool' 角色用——回传的工具结果(纯加法,可选)。 */
  readonly toolResults?: readonly ToolResult[];
}
