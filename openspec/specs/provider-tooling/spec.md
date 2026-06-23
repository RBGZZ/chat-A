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

