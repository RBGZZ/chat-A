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

/**
 * 延迟 metric 名(§8.1:延迟用 Histogram,仿 LiveKit `lk.agents.turn.*`)。
 *
 * 单一命名:metric 名与下面的维度键统一收敛到本文件,避免名字散落漂移(§3.2「单一权威」)。
 * 命名沿 OTel 习惯:点分小写;单位走 Histogram 的 `unit` 字段(统一秒,见 metrics.ts)。
 */
export const METRIC = {
  /** 回合级端到端延迟(从收到用户输入到回复就绪)。 */
  TURN_DURATION: 'chat_a.turn.duration',
  /** LLM 调用延迟(单次 chat/completion 往返)。 */
  LLM_DURATION: 'chat_a.llm.duration',
} as const;

/**
 * metric 维度(标签)键。⚠️ metric 标签**忌高基数**——故只放 provider/model/operation/emotion
 * 这类低基数枚举,**绝不**放 correlation/session/turn id(那是 trace 侧的事)。
 * provider/model/operation 复用 GenAI 同名键,保证 metric 与 trace 两侧标签可对齐。
 */
export const METRIC_ATTR = {
  /** 厂商,如 'deepseek' / 'anthropic'(同 GENAI.PROVIDER_NAME)。 */
  PROVIDER: GENAI.PROVIDER_NAME,
  /** 请求模型串(同 GENAI.REQUEST_MODEL)。 */
  MODEL: GENAI.REQUEST_MODEL,
  /** 操作类型,如 'chat'(同 GENAI.OPERATION_NAME)。 */
  OPERATION: GENAI.OPERATION_NAME,
  /** 本回合情绪标签(chat-A 私有,低基数枚举,如 'content' / 'neutral')。 */
  EMOTION: 'chat_a.emotion',
} as const;
