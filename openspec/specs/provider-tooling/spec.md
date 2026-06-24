# provider-tooling Specification

## Purpose
TBD - created by archiving change provider-tool-use. Update Purpose after archive.
## Requirements
### Requirement: ChatMessage 纯加法表达 tool_use/tool_result

`ChatMessage` SHALL 以**纯加法**方式表达模型侧工具调用,保持 `content: string` 字段及既有 `user`/`assistant` 消息语义完全不变。新增 MUST 全部可选或对旧值无破坏:可选 `toolCalls`(assistant 发起的工具调用,含 `id`/`name`/`input`)、新增 `tool` 角色及可选 `toolResults`(回传工具结果,含 `toolCallId`/`content`/可选 `isError`)。所有仅消费 `.role`/`.content` 的现有跨模块消费者 MUST 无需改动仍通过类型检查。

#### Scenario: 既有 user/assistant 消息零改动仍合法

- **WHEN** 代码构造 `{ role: 'user', content: '...' }` 或 `{ role: 'assistant', content: '...' }`(不带任何工具字段)
- **THEN** 该值满足 `ChatMessage` 类型,且全仓类型检查通过(未改任何其它包)

#### Scenario: assistant 消息携带 tool_use 调用

- **WHEN** 一条 assistant 消息带 `toolCalls: [{ id, name, input }]`
- **THEN** 其 `content` 仍为字符串、语义不变,`toolCalls` 作为附加可选信息可被读取

#### Scenario: tool 角色回传工具结果

- **WHEN** 构造 `{ role: 'tool', content: '', toolResults: [{ toolCallId, content }] }`
- **THEN** 该消息合法,`toolCallId` 与先前 `ToolCall.id` 对齐,供未来 Agent loop 回传

### Requirement: LlmRequest 携带工具定义与工具选择

`LlmRequest` SHALL 支持可选 `tools`(工具定义数组)与可选 `toolChoice`(工具选择策略)。工具定义类型 MUST 含 `name`、`description`、`inputSchema`(JSON schema,映射 Anthropic `input_schema`)。`toolChoice` MUST 可表达 auto / any / 指定工具 / none。未携带 `tools` 时请求语义 MUST 与现状等价。

#### Scenario: 不带 tools 的请求与现状等价

- **WHEN** 构造仅含 `system`/`messages` 的 `LlmRequest`
- **THEN** 类型合法,且既有 `stream`/`complete` 行为不变

#### Scenario: 带 tools 与 toolChoice 的请求

- **WHEN** 构造 `LlmRequest` 含 `tools: [{ name, description, inputSchema }]` 与 `toolChoice: { type: 'tool', name }`
- **THEN** 类型合法,工具定义与选择策略可被工具通道消费

### Requirement: Provider 工具能力标志与可选工具通道

`LlmProvider` SHALL 提供可选能力标志 `supportsTools` 与可选工具通道方法 `completeWithTools` / `streamWithTools`,以表达"文本增量 + tool_use 调用"。既有 `stream(req)=>AsyncIterable<string>` 与 `complete(req)=>Promise<string>` MUST 保持签名与行为完全不变,使现有调用方零改动。`supportsTools` 与工具通道 MUST 仅供能力驱动/调度,业务层不得据 provider id 分支。

#### Scenario: 旧文本通道不受影响

- **WHEN** 调用任一 Provider 的 `stream` 或 `complete`
- **THEN** 返回与本切片之前一致(token 字符串 / 完整文本),现有 runtime 用法不需改动

#### Scenario: 工具通道返回 tool_use 调用

- **WHEN** 对支持工具的 Provider 调用 `completeWithTools`,且模型决定调用工具
- **THEN** 返回结果含 `toolCalls`(0..N)与 `stopReason`('tool_use' 或 'end'),文本部分一并返回

### Requirement: FakeLlm 工具桩支持 tool_use 往返

系统 SHALL 提供 `FakeLlm` 的工具桩能力:可按脚本产出 tool_use 调用,并能在请求消息中带回 tool_result 后推进脚本续写,供未来 Agent loop 做确定性 record-replay 测试。`FakeLlm` 的既有 `stream`/`complete` 行为 MUST 不变。

#### Scenario: 脚本化吐出 tool_use 调用

- **WHEN** 用脚本配置 FakeLlm 在首轮发起一个 tool_use 调用,并对其调用 `completeWithTools`
- **THEN** 返回含该 tool_use 调用、`stopReason` 为 'tool_use'

#### Scenario: 收到 tool_result 后续写

- **WHEN** 将带 `toolResults` 的消息回传并再次调用工具通道
- **THEN** FakeLlm 推进到下一脚本轮,产出后续文本(可引用结果),`stopReason` 为 'end'

#### Scenario: 既有文本桩行为保留

- **WHEN** 对 FakeLlm 调用旧 `stream` / `complete`
- **THEN** 仍返回既有占位/罐装文本,工具桩不影响该路径

### Requirement: 流式 JSON tool-call 检测器(降级备用)

系统 SHALL 提供一个确定性纯函数,从文本缓冲中检测并切出**首个括号配平**的 JSON 对象(字符串/转义感知),供本地模型无原生 tool-use 时从文本流识别约定的 JSON tool-call。该函数 MUST 不依赖任何 Provider、可独立单测;缓冲未含完整平衡对象时 MUST 返回空(等待更多增量)。

#### Scenario: 缓冲含完整平衡对象

- **WHEN** 输入缓冲含一个完整的 `{...}`(含嵌套与字符串内的括号)
- **THEN** 返回切出的 JSON 文本与剩余部分

#### Scenario: 缓冲不完整时等待

- **WHEN** 输入缓冲只含半个对象(括号未配平)
- **THEN** 返回空,表示需等待更多流式增量

### Requirement: OpenAI 兼容 Provider 声明工具能力

`OpenAiCompatLlm` SHALL 将 `supportsTools` 置为 `true`,以表达其支持模型侧工具通道。该标志 MUST 仅供能力驱动/调度与 trace,业务层不得据 provider id 分支。既有 `stream`/`complete` 的签名与行为 MUST 完全不变。

#### Scenario: supportsTools 为 true

- **WHEN** 构造 `OpenAiCompatLlm` 实例并读取 `supportsTools`
- **THEN** 返回 `true`,且其 `stream`/`complete` 行为与本切片之前一致

### Requirement: completeWithTools 映射 OpenAI function calling

`OpenAiCompatLlm.completeWithTools` SHALL 以非流式 POST /chat/completions 请求:当 `LlmRequest.tools` 非空时,请求体 MUST 带 OpenAI `tools`(每项形如 `{ type:'function', function:{ name, description, parameters: inputSchema } }`);当 `LlmRequest.toolChoice` 提供时,请求体 MUST 带映射后的 `tool_choice`。响应解析 MUST 从 `choices[0].message.tool_calls` 提取 `ToolCall[]`(`id`、`name`、`input = tolerantJsonParse(arguments)`),`text` 取 `choices[0].message.content`,并据是否含工具调用产出 `stopReason`。

#### Scenario: 模型返回 tool_calls

- **WHEN** mock 端点返回 `message.tool_calls:[{id,function:{name,arguments}}]` 且 `finish_reason:'tool_calls'`
- **THEN** `completeWithTools` 返回 `toolCalls` 含对应 id/name/已解析 input、`stopReason` 为 `'tool_use'`,`text` 取 message.content

#### Scenario: 模型只返回文本

- **WHEN** mock 端点返回无 `tool_calls`、仅 `message.content`、`finish_reason:'stop'`
- **THEN** 返回 `toolCalls` 为空、`stopReason` 为 `'end'`、`text` 为该 content

#### Scenario: arguments 解析失败容错

- **WHEN** `tool_calls[].function.arguments` 为非法 JSON
- **THEN** 对应 `ToolCall.input` 退化为 `{}`,不抛错,`stopReason` 仍为 `'tool_use'`

### Requirement: streamWithTools 流式聚合 SSE 工具分片

`OpenAiCompatLlm.streamWithTools` SHALL 以流式 SSE 请求并产出 `LlmStreamEvent`:`delta.content` MUST 即时产出 `text` 事件;`delta.tool_calls` 分片 MUST 按 `index` 聚合 `id`/`name`/`arguments`;流结束(`[DONE]` 或字节流耗尽)时,聚合出的每个工具调用 MUST 产出 `tool_use` 事件(`input = tolerantJsonParse(arguments)`),最后 MUST 产出一个 `end` 事件(有工具调用则 `stopReason:'tool_use'`,否则 `'end'`)。

#### Scenario: 文本与工具分片混合流

- **WHEN** SSE 先吐 `delta.content` 片、再吐分属同一 `index` 的 `delta.tool_calls` 名称/参数分片,最后 `[DONE]`
- **THEN** 依次产出对应 `text` 事件、一个聚合好的 `tool_use` 事件、一个 `end`(`stopReason:'tool_use'`)

#### Scenario: 纯文本流

- **WHEN** SSE 只含 `delta.content` 片
- **THEN** 产出对应 `text` 事件后,以 `end`(`stopReason:'end'`)收尾,无 `tool_use`

### Requirement: tool_choice 策略映射

`OpenAiCompatLlm` 的工具通道 SHALL 将 `LlmToolChoice` 映射为 OpenAI `tool_choice`:`auto`→`'auto'`、`any`→`'required'`、`{type:'tool',name}`→`{type:'function',function:{name}}`、`none`→`'none'`。未提供 `toolChoice` 时请求体 MUST 不含 `tool_choice` 字段。

#### Scenario: 指定工具

- **WHEN** `toolChoice` 为 `{ type:'tool', name:'recall_memory' }`
- **THEN** 请求体 `tool_choice` 为 `{ type:'function', function:{ name:'recall_memory' } }`

#### Scenario: any 映射为 required

- **WHEN** `toolChoice` 为 `{ type:'any' }`
- **THEN** 请求体 `tool_choice` 为 `'required'`

### Requirement: 工具往返消息回灌映射

`OpenAiCompatLlm` 的工具通道 SHALL 将 `ChatMessage` 的工具往返映射为 OpenAI 消息:带 `toolCalls` 的 assistant 消息 MUST 映射为 OpenAI assistant 消息含 `tool_calls`(每项 `{id,type:'function',function:{name,arguments:JSON.stringify(input)}}`);`'tool'` 角色消息的每个 `toolResults` 项 MUST 映射为一条 `{ role:'tool', tool_call_id, content }` 消息。该映射 MUST 仅用于工具通道;纯文本 `stream`/`complete` 的消息映射 MUST 不变。

#### Scenario: assistant tool_calls 与 tool 结果回灌

- **WHEN** 请求 messages 含 assistant(带 `toolCalls`)与随后的 `'tool'` 消息(带 `toolResults`)
- **THEN** 发往端点的 messages 含对应的 assistant `tool_calls` 与 `role:'tool',tool_call_id` 消息,id 与原 `ToolCall.id`/`ToolResult.toolCallId` 对齐

#### Scenario: 纯文本路径不受影响

- **WHEN** 对同一 Provider 调用 `stream`/`complete`
- **THEN** 其消息映射与本切片之前一致(非 assistant 含 'tool' 归并为 user),无 `tools`/`tool_choice`/`tool_calls` 字段

### Requirement: Anthropic Provider 声明工具能力

`AnthropicLlm` SHALL 将 `supportsTools` 置为 `true`,以表达其支持模型侧原生 tool-use 通道。该标志 MUST 仅供能力驱动/调度与 trace,业务层不得据 provider id 分支。既有 `stream`/`complete` 的签名与行为 MUST 完全不变。

#### Scenario: supportsTools 为 true

- **WHEN** 构造 `AnthropicLlm` 实例并读取 `supportsTools`
- **THEN** 返回 `true`,且其 `stream`/`complete` 行为与本切片之前一致

### Requirement: completeWithTools 映射 Anthropic 原生 tool-use

`AnthropicLlm.completeWithTools` SHALL 以 `messages.create` 请求:当 `LlmRequest.tools` 非空时,请求体 MUST 带 Anthropic `tools`(每项形如 `{ name, description, input_schema: inputSchema }`);当 `LlmRequest.toolChoice` 提供时,请求体 MUST 带映射后的 `tool_choice`。响应解析 MUST 从 response `content` 的 `tool_use` 块提取 `ToolCall[]`(`id`、`name`、`input`,解析失败容错为 `{}`),`text` 取所有 `text` 块拼接,并据 `stop_reason` 与是否含工具调用产出 `stopReason`。

#### Scenario: 模型返回 tool_use 块

- **WHEN** mock 客户端返回 `content` 含 `{type:'tool_use', id, name, input}` 块且 `stop_reason:'tool_use'`
- **THEN** `completeWithTools` 返回 `toolCalls` 含对应 id/name/input、`stopReason` 为 `'tool_use'`,`text` 取 text 块拼接

#### Scenario: 模型只返回文本

- **WHEN** mock 客户端返回仅 `text` 块、`stop_reason:'end_turn'`
- **THEN** 返回 `toolCalls` 为空、`stopReason` 为 `'end'`、`text` 为 text 块拼接

#### Scenario: tool_use input 容错

- **WHEN** `tool_use` 块的 `input` 为非法 JSON 字符串(或缺失)
- **THEN** 对应 `ToolCall.input` 退化为 `{}`,不抛错,`stopReason` 仍为 `'tool_use'`

### Requirement: streamWithTools 流式聚合 Anthropic SSE 工具分片

`AnthropicLlm.streamWithTools` SHALL 以 `messages.stream` 请求并产出 `LlmStreamEvent`:`content_block_delta` 的 `text_delta` MUST 即时产出 `text` 事件;`content_block_start` 的 `tool_use` 块 MUST 按 `index` 记录 `id`/`name`,`content_block_delta` 的 `input_json_delta` 分片 MUST 按 `index` 聚合 `partial_json`;流结束时,聚合出的每个工具调用 MUST 产出 `tool_use` 事件(`input` 由聚合后的 JSON 解析,失败 `{}`),最后 MUST 产出一个 `end` 事件(有工具调用则 `stopReason:'tool_use'`,否则 `'end'`)。

#### Scenario: 文本与工具分片混合流

- **WHEN** SSE 先吐 `text_delta` 片、再吐同一 `index` 的 `tool_use` 起始块与 `input_json_delta` 参数分片
- **THEN** 依次产出对应 `text` 事件、一个聚合好的 `tool_use` 事件、一个 `end`(`stopReason:'tool_use'`)

#### Scenario: 纯文本流

- **WHEN** SSE 只含 `text_delta` 片
- **THEN** 产出对应 `text` 事件后,以 `end`(`stopReason:'end'`)收尾,无 `tool_use`

### Requirement: Anthropic tool_choice 策略映射

`AnthropicLlm` 的工具通道 SHALL 将 `LlmToolChoice` 映射为 Anthropic `tool_choice`:`auto`→`{type:'auto'}`、`any`→`{type:'any'}`、`{type:'tool',name}`→`{type:'tool',name}`、`none`→`{type:'none'}`。未提供 `toolChoice` 时请求体 MUST 不含 `tool_choice` 字段。

#### Scenario: 指定工具

- **WHEN** `toolChoice` 为 `{ type:'tool', name:'recall_memory' }`
- **THEN** 请求体 `tool_choice` 为 `{ type:'tool', name:'recall_memory' }`

#### Scenario: any 映射

- **WHEN** `toolChoice` 为 `{ type:'any' }`
- **THEN** 请求体 `tool_choice` 为 `{ type:'any' }`

### Requirement: Anthropic 工具往返消息回灌映射

`AnthropicLlm` 的工具通道 SHALL 将 `ChatMessage` 的工具往返映射为 Anthropic 消息块:带 `toolCalls` 的 assistant 消息 MUST 映射为 assistant 消息含 `tool_use` 块(每块 `{type:'tool_use', id, name, input}`,content 非空时前置 `text` 块);`'tool'` 角色消息的每个 `toolResults` 项 MUST 映射为 user 消息里的 `tool_result` 块(`{type:'tool_result', tool_use_id, content, is_error?}`)。该映射 MUST 仅用于工具通道;纯文本 `stream`/`complete` 的消息映射 MUST 不变。

#### Scenario: assistant tool_use 与 tool 结果回灌

- **WHEN** 请求 messages 含 assistant(带 `toolCalls`)与随后的 `'tool'` 消息(带 `toolResults`)
- **THEN** 发往客户端的 messages 含对应的 assistant `tool_use` 块与 user `tool_result` 块,`tool_use_id` 与原 `ToolCall.id`/`ToolResult.toolCallId` 对齐

#### Scenario: 纯文本路径不受影响

- **WHEN** 对同一 Provider 调用 `stream`/`complete`
- **THEN** 其消息映射与本切片之前一致(非 assistant 含 'tool' 归并为 user 字符串内容),无 `tools`/`tool_choice`/`tool_use` 块

### Requirement: LLM Provider 注册与 DashScope(Qwen)纯文本映射

系统 SHALL 通过 LLM Provider 注册表把开放字符串 `provider` 映射到具体实现;加新厂商 MUST 只需在注册表登记工厂,`createLlm` 核心与系统其余部分 MUST 零改动(承 §3.1 接缝)。其中 `qwen` MUST 注册为复用 `OpenAiCompatLlm` 的**纯文本** Provider,默认指向 DashScope OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`(承 §3.3 OpenAI 兼容复用)。该默认 base URL MUST 为具名常量(无 magic number),且 MUST 可经配置覆盖(`LlmConfig.baseURL` / 环境变量 `CHAT_A_LLM_BASE_URL`,承 §3.2 行为即配置)。`qwen` 工厂在 `apiKey` 缺失或为空时 MUST 抛清晰错误(指向应设的环境变量),而非静默构造不可用实例。本要求 MUST 仅覆盖纯文本 chat/completions + SSE 路径;多模态 audio-in(qwen omni 系列)不在本要求范围,留待后续独立能力。

#### Scenario: createLlm 解析 qwen 为 DashScope OpenAI 兼容 Provider

- **WHEN** 以 `{ provider:'qwen', model:'qwen-plus', apiKey:'<key>' }` 调用 `createLlm`
- **THEN** 返回 `OpenAiCompatLlm` 实例,其 `id` 为 `'qwen'`,`baseURL` 为 DashScope OpenAI 兼容端点默认值

#### Scenario: qwen 已登记于注册表

- **WHEN** 读取已注册的 LLM Provider 列表
- **THEN** 列表包含 `'qwen'`,加它未改动 `createLlm` 核心解析逻辑

#### Scenario: 缺 apiKey 抛清晰错误

- **WHEN** 以 `{ provider:'qwen', model:'qwen-plus' }`(无 apiKey)调用 `createLlm`
- **THEN** 抛出明确错误,提示需要设置 API key(环境变量),不返回不可用实例

#### Scenario: base URL 可经配置覆盖

- **WHEN** 以 `{ provider:'qwen', model, apiKey, baseURL:'https://自托管端点/v1' }` 调用 `createLlm`(或经 `CHAT_A_LLM_BASE_URL` 注入)
- **THEN** 返回实例的 `baseURL` 为覆盖后的端点(去尾斜杠),而非内置默认值

### Requirement: OpenAiCompatLlm 暴露只读 baseURL

`OpenAiCompatLlm` SHALL 暴露**只读** `baseURL`(已规整、去尾随斜杠),与已公开的 `id`/`model` 对称,仅供 trace/日志与可测性。该字段 MUST 为纯加法,不改变 `stream`/`complete`/工具通道的 fetch 行为。

#### Scenario: 读取规整后的 baseURL

- **WHEN** 以 `baseURL:'https://x.example/v1/'` 构造 `OpenAiCompatLlm` 并读取其 `baseURL`
- **THEN** 返回 `'https://x.example/v1'`(尾随斜杠被去除),且其 `stream`/`complete` 行为与本切片之前一致

### Requirement: Qwen Omni Realtime(WebSocket 多模态)Provider 注册与 audio-in→文本流

系统 SHALL 通过 LLM Provider 注册表把开放字符串 `provider='qwen-omni'` 映射到基于 DashScope **WebSocket 实时多模态**端点(OpenAI-Realtime 风格协议)的 `QwenOmniLlm`;加它 MUST 只需在注册表登记工厂,`createLlm` 核心与系统其余部分 MUST 零改动(承 §3.1 接缝)。默认 WS 端点 MUST 为具名常量 `QWEN_DASHSCOPE_REALTIME_URL`(`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`,无 magic number),且 MUST 可经 `LlmConfig.baseURL` 覆盖(承 §3.2 行为即配置);model id MUST 由配置传入(不写死快照名)。该 Provider 在 `apiKey` 缺失或为空时 MUST 抛清晰错误(指向应设的环境变量),而非静默构造不可用实例。

该 Provider MUST 实现 `LlmProvider` 的文本兼容面(`stream`/`complete`),把文本 prompt 经 WS(`modalities:["text"]`)送出并聚合 `response.text.delta` 回吐字符串流,使其可作为现有「STT→文本LLM」路径的**可选替代**装入 registry 而**不破坏**现有路径。该 Provider MUST 另提供真多模态面 `respondToAudio`(吃 PCM 块流 → 经 `input_audio_buffer.append` 送出 → 产出 transcript/text/end 判别联合事件),为后续 runtime 接入 audio-in 直路留接缝。该 Provider MUST 支持 `AbortSignal` 真取消(abort 时关闭 WS、停止产出,承 §3.2 真打断),MUST 在鉴权/连接/能力缺失时 fail-fast 抛清晰错误(供上层优雅降级回传统路径),并 MUST 支持 WS 连接注入(工厂模式)以做不依赖真实网络的确定性测试。本要求 MUST 不改动 VoiceLoop / TTS;audio-in 直路接入 VoiceLoop 不在本要求范围。

#### Scenario: createLlm 解析 qwen-omni 为 WS 多模态 Provider

- **WHEN** 以 `{ provider:'qwen-omni', model:'qwen3.5-omni-flash-realtime', apiKey:'<key>' }` 调用 `createLlm`
- **THEN** 返回 `QwenOmniLlm` 实例,其 `id` 为 `'qwen-omni'`,默认 WS 端点为 `QWEN_DASHSCOPE_REALTIME_URL`

#### Scenario: qwen-omni 已登记于注册表

- **WHEN** 读取已注册的 LLM Provider 列表
- **THEN** 列表包含 `'qwen-omni'`,加它未改动 `createLlm` 核心解析逻辑,且与纯文本 `'qwen'` 区分

#### Scenario: 缺 apiKey 抛清晰错误

- **WHEN** 以 `{ provider:'qwen-omni', model }`(无 apiKey)调用 `createLlm`
- **THEN** 抛出明确错误,提示需要设置 API key(环境变量),不返回不可用实例

#### Scenario: 文本兼容面经 WS 流式回吐文本

- **WHEN** 以文本 `LlmRequest` 调用 `stream`,服务端经 WS 回若干 `response.text.delta` 后 `response.done`
- **THEN** `stream` 依序 yield 各 delta 文本,`response.done` 后结束并关闭 WS;请求中含 `session.update`(`modalities:["text"]`)与文本内容项

#### Scenario: 真多模态面 audio-in 产出 transcript 与回复文本

- **WHEN** 向 `respondToAudio` 喂 PCM 块流,服务端回 `conversation.item.input_audio_transcription.completed`(transcript)与 `response.text.delta`(回复)
- **THEN** Provider 把音频经 `input_audio_buffer.append`(base64)送出,并产出 `{type:'transcript'}`(用户话语)+ `{type:'text'}`(回复增量)+ `{type:'end'}`

#### Scenario: AbortSignal 中途真取消

- **WHEN** 流式产出进行中其 `signal` 被 abort
- **THEN** Provider 关闭 WS 并停止产出(生成器终止),不再 yield 后续事件

#### Scenario: 连接/鉴权失败优雅降级

- **WHEN** WS 收到 `error` 事件或发生非正常关闭
- **THEN** 当前调用抛出清晰错误(不打印鉴权字段),供上层 catch 后降级回传统 STT→文本LLM 路径

#### Scenario: WS 连接可注入以确定性测试

- **WHEN** 构造 `QwenOmniLlm` 时注入自定义 WS 工厂(mock)
- **THEN** Provider 用注入的连接收发事件,测试无需真实网络即可覆盖正常流式/打断/错误降级

### Requirement: DashScope qwen-tts-realtime 流式 TTS Provider

系统 SHALL 通过 TTS Provider 注册表把判别联合 `kind:'qwen-tts'` 映射到 `QwenTtsRealtime` 实现,经 DashScope WebSocket(OpenAI-Realtime 风格协议)做**流式语音合成**(承 §4 流式优先、§4.3 可换性)。加它 MUST 只需在注册表登记工厂,`createTts` 核心 MUST 零改动。

`QwenTtsRealtime` MUST 实现 `TtsProvider`:`synthesize(text, opts?, signal?)` 返回 `AsyncIterable<PcmChunk>`,产出 **24kHz mono Int16**(对齐 `TTS_SAMPLE_RATE_HZ`,默认 `response_format=PCM_24000HZ_MONO_16BIT`),且 MUST **边收边产**(收到首个 `response.audio.delta` 即 yield,不等整段),以求低首音延迟。`id` MUST 仅供 trace/日志,业务不得据此分支。

能力声明 MUST 含 `languages`(多语种 `['*']`)、`voiceId`(内置音色)、`sampleRate:24000`、`streaming:true`、`voiceCloning:false`。`synthesize` MUST 先过能力门 fail-fast:语种不在 `languages` 内(`assertTtsLanguage`)、或请求复刻(带 `refAudio`)而 `voiceCloning=false`(`assertTtsCloning`)即抛(承 §4.1/§4.3)。

WebSocket 连接 MUST 经**可注入工厂端口**建立(镜像 kokoro 的 R1 注入接缝),以保证单测**不触真网络**;缺省工厂在真实运行时懒加载 WebSocket 实现建连。鉴权 MUST 用 `Authorization: Bearer <key>` 请求头,且**任何日志/错误信息 MUST NOT 含 key 明文**。默认 base URL/model MUST 为可配置项(无 magic number、不写死日期快照),可经配置/环境变量覆盖(承 §3.2)。

#### Scenario: 流式产出 PcmChunk

- **WHEN** 注入的 WebSocket 依次回放 `session.created`→`response.audio.delta`(base64 PCM)×N→`response.done`,调用 `synthesize(text)`
- **THEN** 迭代器逐个产出对应 `PcmChunk`(`sampleRate===24000`、`channels===1`、`samples` 为 base64 解码后的 Int16 小端样本),首帧到达即产出、不等整段

#### Scenario: AbortSignal 中途取消真停

- **WHEN** `synthesize(text, opts, signal)` 进行中(已建连、尚有未收音频),`signal` 被 `abort()`
- **THEN** 迭代器停止继续产出,且实现向服务端发 `input_text_buffer.clear` 并关闭 WebSocket(不再后台合成/烧远端额度)

#### Scenario: 连接/鉴权/协议错误优雅降级

- **WHEN** WebSocket 触发 `error`/异常 `close`,或服务端回 `error` 事件
- **THEN** `synthesize` 抛出带上下文的清晰中文错误(含 provider id 与错误片段,**不含 key 明文**),由上层按既有降级策略处理,而非静默吞或崩溃

#### Scenario: 能力门拒绝复刻与不支持语种

- **WHEN** 调用 `synthesize` 时带 `refAudio`(请求复刻),或 `opts.language` 不在能力 `languages` 内
- **THEN** 分别因 `voiceCloning=false` / 语种不支持而 fail-fast 抛错,不建立连接

#### Scenario: 缺 apiKey 构造即报错

- **WHEN** 以缺失/空 `apiKey` 构造 `QwenTtsRealtime`(或经工厂)
- **THEN** 构造即抛清晰错误,提示设置 `CHAT_A_DASHSCOPE_API_KEY`(或 `CHAT_A_TTS_API_KEY`),不返回不可用实例

#### Scenario: qwen-tts 已登记于注册表且可配置解析

- **WHEN** 读取已注册 TTS kinds,并以 `CHAT_A_TTS_KIND=qwen-tts` + 相关 env 调 `loadTtsConfig`
- **THEN** kinds 列表含 `'qwen-tts'`;`loadTtsConfig` 返回 `kind:'qwen-tts'` 配置(model/voice/endpoint 等正确,apiKey 可回落 `CHAT_A_DASHSCOPE_API_KEY`),加它未改动 `createTts` 核心解析逻辑

### Requirement: SttResult 纯加法携带 prosody 情绪信号

`SttResult` SHALL 新增**可选** `emotion?: SttEmotion` 字段,承载 STT 从语音读出的 prosody 情绪信号(§7#5「听出怎么说的」),且 MUST 为**纯加法**:既有 STT Provider(`fake`/`openai-compat`/`whisper-local`)MUST NOT 设置该键(`exactOptionalPropertyTypes` 下字段缺席),从而既有 `SttProvider` 消费者读到 `undefined`、行为字面不变。

`SttEmotion` MUST 含离散标签 `label: SttEmotionLabel`(枚举:`surprised`/`neutral`/`happy`/`sad`/`disgusted`/`angry`/`fearful`,对齐 qwen3-asr 官方 7 类),并 MAY 含可选 `confidence?: number`。该类型 MUST 与具体 provider 解耦(任何能产 prosody 情绪的 STT 实现皆可填),为后续 realtime ASR 复用同一返回面留接缝。

#### Scenario: 既有 STT provider 不携带 emotion(行为不变)

- **WHEN** 调用 `FakeStt` / `OpenAiCompatStt` / `WhisperLocalStt` 的 `transcribe` 并收集结果
- **THEN** 每条 `SttResult` MUST NOT 含 `emotion` 键(消费者读到 `undefined`),既有断言与 golden 全部保持通过

### Requirement: DashScope qwen3-asr-flash STT Provider(经 OpenAI 兼容 chat/completions 解析 prosody 情绪)

系统 SHALL 通过 STT Provider 注册表把判别联合 `kind:'qwen-asr'` 映射到 `QwenAsrStt` 实现,经 DashScope **OpenAI 兼容 `/chat/completions`** 端点(qwen3-asr 多模态 chat 形态,音频走 `input_audio` base64 Data URL)做**批式**语音转写,并在转写文本之外解析**说话人 prosody 情绪**(承 §7#5、§4.1/§4.3)。加它 MUST 只需在注册表登记工厂,`createStt` 核心 MUST 零改动。

`QwenAsrStt` MUST 实现 `SttProvider`:`transcribe(audio, opts?, signal?)` 把入口 `AsyncIterable<PcmChunk>` 聚合为单个 WAV 上传,产出**一条** `isFinal:true` 的 `SttResult`,其 `text` 取 `choices[0].message.content`、其 `emotion`(若服务端 `choices[0].message.annotations[]` 给出合法 `emotion`)取首条情绪标注映射成 `SttEmotion`;**无 annotations / emotion 非法值时 MUST NOT 设 `emotion` 键**(纯加法,优雅降级)。能力声明 MUST 含 `languages`(默认多语种 `['*']`)、`streaming:false`、`sampleRate:16000`;`transcribe` MUST 先过 `assertSttLanguage` 能力门 fail-fast。

HTTP 调用 MUST 经**可注入 fetch 端口**完成(缺省用全局 `fetch`),以保证单测**不触真网络**。鉴权 MUST 用 `Authorization: Bearer <key>` 请求头,且**任何日志/错误 MUST NOT 含 key 明文**。缺失/空 `apiKey` 构造 MUST fail-fast(提示设置 `CHAT_A_DASHSCOPE_API_KEY`)。默认 base URL/model MUST 为可配置项(无 magic number、不写死日期快照),可经配置/环境变量覆盖。`id` MUST 仅供 trace/日志,业务不得据此分支。

#### Scenario: 解析转写文本与 prosody 情绪

- **WHEN** 注入的 fetch 返回 `choices[0].message.content="今天好累啊"` 且 `choices[0].message.annotations[0].emotion="sad"`,调用 `transcribe`
- **THEN** 产出单条 `SttResult{ text:"今天好累啊", isFinal:true, emotion:{label:'sad'} }`(请求为 `POST {baseURL}/chat/completions`,body 含 `model` + `messages` 内 `input_audio` base64 Data URL),全程不触网

#### Scenario: 无情绪标注时不设 emotion 键

- **WHEN** 注入的 fetch 返回有 `content` 但 `annotations` 缺失/为空/`emotion` 为非法值
- **THEN** 产出的 `SttResult` MUST NOT 含 `emotion` 键(消费者读到 `undefined`,链路按无信号处理)

#### Scenario: 缺 apiKey 与不支持语种 fail-fast

- **WHEN** 以缺失/空 `apiKey` 构造 `QwenAsrStt`,或 `opts.language` 不在能力 `languages` 内
- **THEN** 分别在构造期 / `transcribe` 入口 fail-fast 抛清晰错误(缺 key 提示 `CHAT_A_DASHSCOPE_API_KEY`),不发起请求

#### Scenario: HTTP 错误优雅降级且不泄漏 key

- **WHEN** 注入的 fetch 返回非 2xx(如 500)
- **THEN** `transcribe` 抛带 status 与正文片段的清晰中文错误(**不含 key 明文**),由上层按既有降级策略处理

#### Scenario: qwen-asr 已登记于注册表且可配置解析

- **WHEN** 读取已注册 STT kinds,并以 `CHAT_A_STT_KIND=qwen-asr` + `CHAT_A_DASHSCOPE_API_KEY` 调 `loadSttConfig`
- **THEN** kinds 列表含 `'qwen-asr'`;`loadSttConfig` 返回 `kind:'qwen-asr'` 配置(model/baseURL 内置默认,apiKey 回落 `CHAT_A_DASHSCOPE_API_KEY`),且既有 `kind=qwen` 便捷档解析保持不变

### Requirement: qwen-tts-realtime 下发输出语种为 Qwen language_type

`QwenTtsRealtime.synthesize` SHALL 把请求的输出语种(`TtsOptions.language`,项目内部统一 ISO 码)映射为 DashScope qwen-tts-realtime 的 `session.language_type` 取值(合法值为首字母大写英文名:`Auto/Chinese/English/German/Italian/Portuguese/Spanish/Japanese/Korean/French/Russian`),并写入握手 `session.update.session.language_type`,以让「语音 I/O 语种解耦」(§4.1)在 qwen TTS 侧真正生效。

映射 MUST 经具名 helper `toQwenLanguageType` 完成(放 `providers` 内、具名常量、无 magic number):ISO 码(`zh/en/ja/ko/de/it/pt/es/fr/ru`,大小写不敏感)映成对应 Qwen 名;已是合法 Qwen 名则归一原样返回(兼容用户直传)。

**回归硬线**:当 `opts.language` **未给** 或为**未知码**时,`toQwenLanguageType` MUST 返回 undefined,且 `synthesize` MUST NOT 在 `session.update` 中包含 `language_type` 字段(等价服务端默认 `Auto`,与未配置语种前的行为逐字一致)。映射不可识别的语种 MUST NOT 抛错(优雅,落回 Auto)。

#### Scenario: 已配置输出语种 → 下发对应 language_type

- **WHEN** 以 `synthesize(text, { language: 'zh' })` 合成(注入 mock WS)
- **THEN** 握手 `session.update.session.language_type` 等于 `'Chinese'`;同理 `'en'` → `'English'`

#### Scenario: 未配置语种 → 不发 language_type(逐字回归)

- **WHEN** 以 `synthesize(text)`(不带 language)或带未知码(如 `'xx'`)合成
- **THEN** 握手 `session.update` 不含 `language_type` 字段,合成产出与未做本次校准前逐字一致

#### Scenario: toQwenLanguageType 映射契约

- **WHEN** 调用 `toQwenLanguageType`
- **THEN** `'zh'→'Chinese'`、`'en'→'English'`;未给/未知码 → `undefined`;直传合法 Qwen 名(如 `'Chinese'`)→ 原样返回

### Requirement: 声音复刻列表分页与音色 id 兼容解析

千问声音复刻的 **list** 请求 SHALL 携带分页参数(`page_index` 与可配的 `page_size`,默认具名常量,如 100),避免服务端只返首页导致音色漏列;query/delete 不带分页。list 响应解析 SHALL 兼容音色元素 id 出现在 `voice` 或 `voice_id` 两种字段(取 `voice` 失败回退 `voice_id`),以容忍服务端形态差异。

注:create / query / delete 链路(端点、`buildCreateBody`、base64 data URI、`output.voice` 解析、裸动词 `list`/`delete` + `voice` 字段)已据官方核实(2026-06-24)正确,本要求只在其上补分页与元素 id 兼容。CosyVoice 是另一套契约(`list_voice`/`delete_voice` + `voice_id`,语种走注册期 `language_hints`),不可与本路径混用。

#### Scenario: list 请求带分页

- **WHEN** 调用 `listVoices`(注入 mock fetch)
- **THEN** 请求体 `input` 含 `action:'list'` + `page_index:0` + `page_size`(等于配置/默认页大小)

#### Scenario: 列表元素 id 兼容 voice 与 voice_id

- **WHEN** list 响应元素分别为 `{ voice:'a' }` 与 `{ voice_id:'b' }`
- **THEN** `parseVoiceList` 解析得到 `['a','b']`(`voice` 取不到时回退 `voice_id`)

### Requirement: 复刻 target_model 与合成 model 一致性纪律

千问声音复刻得到的音色 SHALL 绑定单一目标模型:创建时的 `target_model` 与后续合成时使用的 model MUST 逐字一致(含日期快照整串),否则合成失败。实现 MUST 支持 `createVoice` 经 `targetModel` 覆盖、合成经 `voiceId` 覆盖,且装配层(desktop)持久化复刻 voiceId 时 MUST 按当前合成 model 选取一致的 `target_model`。

#### Scenario: 装配层据合成 model 推 target_model

- **WHEN** 配置 `CHAT_A_TTS_MODEL` 为某 vc 合成模型,经装配层一键复刻
- **THEN** 复刻 `target_model` 取该合成模型整串(否则回落默认 vc 模型),确保复刻得到的 voiceId 可被同一 model 合成

