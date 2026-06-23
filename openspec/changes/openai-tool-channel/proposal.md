## Why

§3.3 定的模型侧工具协议是 **Anthropic 原生 tool-use**;`LlmProvider` 接缝(`llm.ts`)已铺好工具通道:`LlmRequest.tools?/toolChoice?`、`supportsTools?`、可选 `completeWithTools?`/`streamWithTools?`,`FakeLlm` 也落地了桩。但**真 OpenAI 兼容 Provider**(`OpenAiCompatLlm`,DeepSeek/月之暗面/通义等)目前只有纯文本 `stream`/`complete`,**没有工具通道**——小雪换到这些端点就丢了"会调工具"的能力。

本切片在 `OpenAiCompatLlm` 内实现 OpenAI 函数调用(function calling)到既有接缝的映射,使其与 `FakeLlm`/未来 `AnthropicLlm` 工具通道契约一致。**纯加法、只在 openai-compat 内实现可选方法**:接缝定义(`llm.ts`)、`fake-llm.ts`、`anthropic-llm.ts` 的现有契约一律不动;`OpenAiCompatLlm` 既有纯文本 `stream`/`complete` 路径**形状与行为完全不变**。

## What Changes

- **`supportsTools = true`**:`OpenAiCompatLlm` 声明工具能力(仅供能力驱动/trace,业务不据 id 分支)。
- **`completeWithTools`**:POST /chat/completions(非流式)带 OpenAI `tools`(`{type:'function',function:{name,description,parameters:inputSchema}}`)+ `tool_choice`;解析 `choices[0].message.tool_calls` → `ToolCall[]`(id/name/`tolerantJsonParse(arguments)`),`finish_reason`('tool_calls'→`tool_use`,else `end`)→ `stopReason`,text 取 `message.content`。
- **`streamWithTools`**:SSE 解析 `delta.tool_calls` 按 `index` 聚合 name/arguments 分片,`delta.content` → `text` 事件,结束 emit `end`(按是否聚合出工具调用决定停因)。
- **工具往返回灌**:把 `ChatMessage` 的 assistant `toolCalls` / `'tool'` 角色 `toolResults` 映射成 OpenAI 的 assistant `tool_calls` + `role:'tool',tool_call_id` 消息——**仅工具通道用**;纯文本 stream/complete 的消息映射不变。
- **`tool_choice` 映射**:auto→`'auto'`、any→`'required'`、tool→`{type:'function',function:{name}}`、none→`'none'`。
- **优雅降级**:解析失败 / 无 `tool_calls` 时降级为纯文本 `end`(不抛进回合)。

## Capabilities

### Modified Capabilities
- `provider-tooling`: 在既有"模型侧工具接缝"上,新增 **OpenAI 兼容 Provider 的真实工具线缆**(function calling 映射:tools/tool_choice 请求、tool_calls 解析与 SSE 分片聚合、tool_use/tool_result 回灌、容错降级)。

## Impact

- **canonical 章节/接缝**:§3.3(模型侧工具协议落到 OpenAI 兼容端点)、§3.1(Provider 接缝可扩展、业务厂商无感)、§3.2(优雅降级:解析失败回退纯文本;旧通道不变)、§4(流式贯穿:工具通道仍 yield 文本增量)。
- **代码(仅本切片范围)**:`packages/providers/src/openai-compat-llm.ts`(实现 `supportsTools`/`completeWithTools`/`streamWithTools` + 工具消息映射 + SSE 工具分片聚合)、`packages/providers/test`(新增工具通道测试,mock fetch/SSE)。
- **不改任何其它包**,也不改 `llm.ts`/`fake-llm.ts`/`anthropic-llm.ts` 的现有契约。纯文本 `stream`/`complete` 路径零改动。
- **依赖**:无新外部依赖(原生 fetch)。
- **延迟预算(§3.2)**:旧路径不变,零额外首字延迟;工具通道为新增可选路径。

## Non-goals

- Agent loop 循环(检测 tool_use → 执行 → 回传 → 再请求)——由 runtime 后续切片负责。
- 接真 MCP / 能力侧协议——后续切片。
- `AnthropicLlm` 真实工具线缆 / `tool_choice` 强制语义的真模型端到端验证。
- 并行工具调用执行 / 错误重试策略。
