## Why

§3.3 定的模型侧工具协议是 **Anthropic 原生 tool-use**。`LlmProvider` 接缝(`llm.ts`)已铺好工具通道:`LlmRequest.tools?/toolChoice?`、`supportsTools?`、可选 `completeWithTools?`/`streamWithTools?`;`FakeLlm` 已落地桩,`OpenAiCompatLlm` 也已补齐 OpenAI 兼容端的工具线缆。但**真 Claude Provider**(`AnthropicLlm`,`anthropic-llm.ts`)目前**只有纯文本 `stream`/`complete`,没有工具通道**——小雪用真 Claude 端点时就丢了"会调工具"的能力,也未能落到 §3.3 锚定的原生协议。

本切片在 `AnthropicLlm` 内实现 Anthropic 原生 tool-use 到既有接缝的映射,使其与 `FakeLlm`/`OpenAiCompatLlm` 工具通道契约**对称**。**纯加法、只在 `anthropic-llm.ts` 内实现可选方法**:接缝定义(`llm.ts`)、`fake-llm.ts`、`openai-compat-llm.ts` 的现有契约一律不动;`AnthropicLlm` 既有纯文本 `stream`/`complete` 路径**形状与行为完全不变**。

## What Changes

- **`supportsTools = true`**:`AnthropicLlm` 声明工具能力(仅供能力驱动/trace,业务不据 id 分支)。
- **`completeWithTools`**:`messages.create` 带 Anthropic `tools`(`{name,description,input_schema}`)+ `tool_choice`;解析 response `content` 里的 `tool_use` 块 → `ToolCall[]`(id/name/input),`stop_reason==='tool_use'`→`tool_use` 否则 `end`,text 取所有 `text` 块拼接。
- **`streamWithTools`**:`messages.stream` 的 Anthropic SSE(`content_block_start` 取 tool_use 块 id/name、`content_block_delta` 的 `input_json_delta` 聚合 input JSON 分片、`text_delta` → `text` 事件),结束逐个 emit `tool_use` 再 emit `end`(按是否聚合出工具调用决定停因)。
- **工具往返回灌**:把 `ChatMessage` 的 assistant `toolCalls` → Anthropic assistant `tool_use` 块;`'tool'` 角色 `toolResults` → user 消息里的 `tool_result` 块(`tool_use_id` 对齐)——**仅工具通道用**;纯文本 `stream`/`complete` 的消息映射不变。
- **`tool_choice` 映射**:auto→`{type:'auto'}`、any→`{type:'any'}`、tool→`{type:'tool',name}`、none→`{type:'none'}`。
- **优雅降级**:tool_use 块的 input JSON 用 `tolerantJsonParse`;解析失败 / 无 tool_use 时降级为纯文本 `end`(不抛进回合)。

## Capabilities

### Modified Capabilities
- `provider-tooling`: 在既有"模型侧工具接缝 + OpenAI 兼容工具线缆"上,新增 **Anthropic 原生 Provider 的真实工具线缆**(原生 tool-use 映射:tools/tool_choice 请求、`tool_use` 块解析与 SSE `input_json_delta` 聚合、`tool_use`/`tool_result` 块回灌、容错降级)。

## Impact

- **canonical 章节/接缝**:§3.3(模型侧工具协议落到 Anthropic 原生端点,与锚定一致)、§3.1(Provider 接缝可扩展、业务厂商无感、与 OpenAI 兼容实现对称)、§3.2(优雅降级:解析失败回退纯文本;旧通道不变)、§4(流式贯穿:工具通道仍 yield 文本增量)。
- **代码(仅本切片范围)**:`packages/providers/src/anthropic-llm.ts`(实现 `supportsTools`/`completeWithTools`/`streamWithTools` + 工具消息映射 + SSE `input_json_delta` 聚合)、`packages/providers/test`(新增工具通道测试,mock 模拟 Anthropic 响应与 SSE)。
- **不改任何其它包**,也不改 `llm.ts`/`fake-llm.ts`/`openai-compat-llm.ts` 的现有契约。纯文本 `stream`/`complete` 路径零改动。
- **依赖**:无新外部依赖(沿用 `@anthropic-ai/sdk`)。
- **延迟预算(§3.2)**:旧路径不变,零额外首字延迟;工具通道为新增可选路径。

## Non-goals

- Agent loop 循环(检测 tool_use → 执行 → 回传 → 再请求)——由 runtime 后续切片负责。
- 接真 MCP / 能力侧协议——后续切片。
- 真模型端到端验证(本切片走 mock fetch/SSE 模拟 Anthropic 响应)。
- 并行工具调用执行 / 错误重试策略 / `disable_parallel_tool_use` 等强制语义。
