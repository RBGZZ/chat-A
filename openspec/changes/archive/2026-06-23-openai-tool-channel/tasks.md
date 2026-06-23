## 1. 工具能力与请求构造（packages/providers/src/openai-compat-llm.ts）

- [x] 1.1 `supportsTools = true`
- [x] 1.2 `tools` 映射:`LlmToolDef` → `{type:'function',function:{name,description,parameters:inputSchema}}`
- [x] 1.3 `tool_choice` 映射:auto→'auto'、any→'required'、tool→`{type:'function',function:{name}}`、none→'none';未提供则不带该字段
- [x] 1.4 工具消息映射 `#buildToolMessages`:assistant.toolCalls → OpenAI `tool_calls`;'tool'.toolResults → `role:'tool',tool_call_id` 消息;其余照旧（纯文本 `#buildMessages` 不动）

## 2. completeWithTools（非流式）

- [x] 2.1 POST /chat/completions（stream:false）带 tools/tool_choice
- [x] 2.2 解析 `choices[0].message.tool_calls` → `ToolCall[]`（id/name/`tolerantJsonParse(arguments)`，失败退化 `{}`）
- [x] 2.3 `finish_reason`('tool_calls'→'tool_use' else 'end')与"是否含工具调用"共同决定 stopReason；text 取 message.content
- [x] 2.4 无 tool_calls 时降级为纯文本 end

## 3. streamWithTools（SSE）

- [x] 3.1 复用 SSE 逐行解析;`delta.content` → emit `text`
- [x] 3.2 `delta.tool_calls` 按 `index` 聚合 id/name/arguments 分片
- [x] 3.3 结束（`[DONE]`/字节流耗尽）逐个 emit `tool_use`（`tolerantJsonParse(args)`），最后 emit `end`（有工具→'tool_use' 否则 'end'）
- [x] 3.4 单片解析失败跳过不中断（沿用 try/catch 风格）

## 4. 测试（packages/providers/test，mock fetch / SSE）

- [x] 4.1 completeWithTools:返回 tool_calls → 解析出 ToolCall + stopReason 'tool_use'；arguments 非法 JSON → input 退化 `{}`
- [x] 4.2 completeWithTools:无 tool_calls → 纯文本 end
- [x] 4.3 streamWithTools:文本片 + 跨 chunk 同 index 工具分片 → text 事件 + 聚合 tool_use + end('tool_use')
- [x] 4.4 streamWithTools:纯文本流 → text + end('end')
- [x] 4.5 tool_choice 映射断言(any→'required'、tool→function、none→'none')；请求体含 OpenAI tools 格式
- [x] 4.6 回灌:assistant.toolCalls/'tool'.toolResults → 请求体 assistant `tool_calls` + `role:'tool',tool_call_id`
- [x] 4.7 向后兼容:纯文本 stream/complete 请求体不含 tools/tool_choice，消息映射不变

## 5. 验收

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 5.2 worktree 根 `npx vitest run` 全绿
- [x] 5.3 `openspec validate openai-tool-channel --strict` 通过
