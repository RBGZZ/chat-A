## Why

§3.3 定的工具协议是**模型侧 Anthropic 原生 tool-use**,但当前 `LlmProvider` 只表达"纯文本回合":`stream(req)=>token`、`complete(req)=>string`,`LlmRequest` 无 `tools`,`ChatMessage` 只有 `{role,content}`。要让小雪未来"会查记忆/会调能力"(Agent loop),必须先把**模型侧工具调用**做成接缝——本切片只铺接缝与桩,**不接真 MCP、不做 Agent loop 循环**(后续切片)。

关键约束是**向后兼容**:`ChatMessage` 现为跨模块共享类型(cognition assembler、memory snapshot 等都消费 `.role`/`.content`),工具表达必须**纯加法**,既有 user/assistant 消息零改动仍编译。

## What Changes

- **ChatMessage 纯加法扩展**:`content: string` 与既有 user/assistant 语义**完全不变**;新增可选 `toolCalls?`(assistant 发起的工具调用)与新增 `'tool'` 角色 + 可选 `toolResults?`(回传工具结果)。所有现有消费者(只读 `.role`/`.content`)零改动仍通过 typecheck。
- **LlmRequest 加 `tools?` / `toolChoice?`**:工具定义类型 `LlmToolDef { name; description; inputSchema }`(JSON-schema 入参,承 Anthropic `input_schema`);`toolChoice` 表达 auto/any/tool/none。
- **LlmProvider 能力标志 + 工具通道(向后兼容)**:加可选 `supportsTools?: boolean`;新增**可选**方法 `completeWithTools?` / `streamWithTools?` 表达"文本增量 + tool_use 调用",**既有 `stream(token)=>string` / `complete()=>string` 完全不动**(runtime/conversation.ts 现用法不受影响)。
- **FakeLlm 工具桩**:可按脚本吐 tool_use 调用、并能在收到 tool_result 后续写,供未来 Agent loop 做确定性 record-replay 测试。
- **prompt 模式降级骨架(加分)**:括号配平的流式 JSON tool-call 检测纯函数 + 测试(本地模型无原生 tool-use 时备用)。

## Capabilities

### New Capabilities
- `provider-tooling`: 模型侧 Anthropic 原生 tool-use 接缝——工具定义类型、`LlmRequest.tools/toolChoice`、Provider 能力标志与可选工具通道、ChatMessage 纯加法的 tool_use/tool_result 表达、FakeLlm 工具桩、流式 JSON tool-call 检测器(降级备用)。

## Impact

- **canonical 章节/接缝**:§3.3(模型侧 Anthropic 原生 tool-use)、§3.1(Provider 接缝可扩展、业务厂商无感)、§3.2(可测试性:FakeLlm 桩 + 确定性检测器;优雅降级:旧通道不变)、§4(流式贯穿:工具通道仍 yield 文本增量)。
- **代码(仅本切片范围)**:
  - `packages/protocol/src/chat.ts`:`ChatMessage` 纯加法(+ index 导出新类型若需)。
  - `packages/providers`:`llm.ts`(tools/toolChoice/能力标志/可选工具方法 + 工具事件类型)、`fake-llm.ts`(工具桩)、新增 `tool-json.ts`(流式 JSON 检测器)+ 测试。
- **不改任何其它包**:runtime/cognition/persona/memory/observability/client 全部零改动,纯加法保证仍 typecheck。
- **依赖**:无新外部依赖。
- **延迟预算(§3.2)**:旧 stream/complete 路径不变,零额外首字延迟;工具通道为新增可选路径。

## Non-goals

- Agent loop 循环(检测 tool_use → 执行 → 回传 tool_result → 再请求)——后续切片。
- 接真 MCP / 能力侧协议——后续切片。
- 各 Provider(anthropic/openai-compat)真实工具线缆实现——本切片只在 FakeLlm 落地桩;真 Provider 的 `completeWithTools`/`streamWithTools` 留作后续(`supportsTools` 默认按需声明)。
- 工具结果的并行/错误重试策略、tool_choice 强制语义在真模型上的端到端验证。
