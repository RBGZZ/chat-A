/**
 * 追踪属性约定(承 §8.1)。一套命名贯穿 trace/日志/SQLite 决策 trace。
 *
 * ⚠️ GenAI 语义约定在 OTel 仍是 **Development 级**,键名会变——这里**硬编码并锁版本**
 *   (升级 @opentelemetry/semantic-conventions 时回来核对),避免引 incubating 子路径随其漂移。
 */

/** GenAI 语义约定属性键(LLM span 用)。 */
export const GENAI = {
  /** 操作类型,如 'chat'。 */
  OPERATION_NAME: 'gen_ai.operation.name',
  /** 厂商,如 'deepseek' / 'anthropic'(取自 Provider.id,仅 trace)。 */
  PROVIDER_NAME: 'gen_ai.provider.name',
  /** 请求模型串。 */
  REQUEST_MODEL: 'gen_ai.request.model',
  /** token 用量(可得时填)。 */
  USAGE_INPUT_TOKENS: 'gen_ai.usage.input_tokens',
  USAGE_OUTPUT_TOKENS: 'gen_ai.usage.output_tokens',
  /** 会话 ID = sessionId,串联同一会话的多回合。 */
  CONVERSATION_ID: 'gen_ai.conversation.id',
  /** 输出形态,如 'text' / 'speech'。 */
  OUTPUT_TYPE: 'gen_ai.output.type',
} as const;

/**
 * chat-A 私有属性:关联 ID 等。
 * `correlation_id` 是 OTel trace ↔ SQLite 决策 trace 的**缝合键**(§8.1 两层同 ID)。
 */
export const CHAT_A = {
  CORRELATION_ID: 'chat_a.correlation_id',
  SESSION_ID: 'chat_a.session_id',
  TURN_ID: 'chat_a.turn_id',
} as const;
