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
  /**
   * 语音/回合各阶段延迟(仿 LiveKit `lk.agents.turn.*`:同一族 Histogram,阶段走 `chat_a.stage` 维度)。
   *
   * 单一 Histogram + 阶段标签(而非每阶段一个 metric 名),便于跨阶段对齐查询、维度低基数可控;
   * `STAGE.*` 枚举即此 Histogram 的合法 `chat_a.stage` 取值。
   */
  STAGE_DURATION: 'chat_a.stage.duration',
} as const;

/**
 * 语音/回合阶段枚举(§4 语音管线各阶段 + §8.1 关键里程碑),作 `STAGE_DURATION` 的 `chat_a.stage` 维度值。
 *
 * 低基数枚举(忌乱填自由字符串)。命名沿 OTel 点分小写习惯,与 §8.1 span 树 `{stt,llm,tts,classify}` 对齐。
 */
export const STAGE = {
  /** 回合级端到端(从收到用户输入到回复就绪),与 span 树 `turn` 对齐。 */
  TURN: 'turn',
  /** 首 token 时延(TTFT:从回合开始到 LLM 吐出第一个 token)。 */
  TTFT: 'ttft',
  /** 首音频时延(TTFA:从回合开始到第一帧音频就绪)。 */
  TTFA: 'ttfa',
  /** 语音转文字(STT)。 */
  STT: 'stt',
  /** LLM 生成(单次往返;与 `LLM_DURATION` 同义,放阶段族便于一处聚合)。 */
  LLM: 'llm',
  /** 文字转语音(TTS)。 */
  TTS: 'tts',
  /** 分类/情绪评估等旁路处理(§4 流式 3 层过滤里的情绪标签分流)。 */
  CLASSIFY: 'classify',
} as const;

/** 阶段名联合类型,供记录 API 入参约束(只接受已知阶段,杜绝拼写漂移)。 */
export type StageName = (typeof STAGE)[keyof typeof STAGE];

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
  /** 语音/回合阶段(chat-A 私有,低基数枚举,取值见 `STAGE.*`)。 */
  STAGE: 'chat_a.stage',
} as const;
