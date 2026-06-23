## ADDED Requirements

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
