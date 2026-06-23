## 1. ChatMessage 纯加法（packages/protocol）

- [x] 1.1 `ChatRole` 扩为 `'user' | 'assistant' | 'tool'`（旧两值不变，纯加法）
- [x] 1.2 新增 `ToolCall { id; name; input: unknown }`、`ToolResult { toolCallId; content; isError? }`
- [x] 1.3 `ChatMessage` 加可选 `toolCalls?`、`toolResults?`；`content: string` 与既有语义不变
- [x] 1.4 从 `packages/protocol`（chat + index）导出新类型
- [x] 1.5 验收：未改任何其它包，全仓 `pnpm -r typecheck` 通过（cognition/memory 等只读 .role/.content 仍编译）

## 2. LlmRequest 工具定义与选择（packages/providers/src/llm.ts）

- [x] 2.1 定义 `LlmToolDef { name; description; inputSchema }`（JSON schema 映射 Anthropic input_schema）
- [x] 2.2 定义 `LlmToolChoice`（auto / any / { type:'tool', name } / none）
- [x] 2.3 `LlmRequest` 加可选 `tools?`、`toolChoice?`（不带时与现状等价）

## 3. Provider 能力标志与工具通道（packages/providers/src/llm.ts）

- [x] 3.1 `LlmProvider` 加可选 `supportsTools?: boolean`（仅能力/trace，业务不分支）
- [x] 3.2 定义工具响应/流事件类型：`LlmToolResponse { text; toolCalls; stopReason }`、`LlmStreamEvent`（text 增量 / tool_use 调用 / 结束）
- [x] 3.3 `LlmProvider` 加可选 `completeWithTools?`、`streamWithTools?`；**既有 `stream`/`complete` 签名与行为不动**

## 4. FakeLlm 工具桩（packages/providers/src/fake-llm.ts）

- [x] 4.1 `FakeLlmOptions` 加 `toolScript?`（按轮脚本：文本 + 0..N tool_use）
- [x] 4.2 实现 `completeWithTools`（聚合当前脚本轮）与 `streamWithTools`（逐 token 文本增量 + tool_use 事件）；`supportsTools = true`
- [x] 4.3 收到带 `toolResults` 的消息时推进脚本到下一轮（模拟 Agent loop 回传后续写）
- [x] 4.4 旧 `stream`/`complete` 行为完全保留

## 5. 流式 JSON tool-call 检测器（packages/providers/src/tool-json.ts，加分）

- [x] 5.1 `detectToolCallJson(buffer): { json; rest } | null`——括号配平、字符串/转义感知、纯函数
- [x] 5.2 从 index 导出

## 6. 测试（packages/providers/test）

- [x] 6.1 FakeLlm 工具桩：`completeWithTools` 吐 tool_use；回传 tool_result 后续写到 end
- [x] 6.2 FakeLlm 工具桩：`streamWithTools` 先吐文本增量、再吐 tool_use 事件；旧 stream/complete 不受影响
- [x] 6.3 tools/toolChoice/supportsTools 类型与传参可用（FakeLlm 接收 tools 不报错）
- [x] 6.4 `detectToolCallJson`：完整平衡对象切出 / 含字符串内括号 / 不完整返回 null
- [x] 6.5 向后兼容冒烟：构造旧式 user/assistant 消息仍合法（编译级 + 运行级）

## 7. 验收

- [x] 7.1 worktree 根 `pnpm -r typecheck` 全绿（确认未改的包仍编译）
- [x] 7.2 worktree 根 `npx vitest run` 全绿
- [x] 7.3 `openspec validate provider-tool-use --strict` 通过
