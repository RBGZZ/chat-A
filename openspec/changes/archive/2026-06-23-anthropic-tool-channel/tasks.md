## 1. 工具能力与请求构造（packages/providers/src/anthropic-llm.ts）

- [x] 1.1 `supportsTools = true`
- [x] 1.2 `tools` 映射:`LlmToolDef` → Anthropic `{name, description, input_schema: inputSchema}`
- [x] 1.3 `tool_choice` 映射:auto→`{type:'auto'}`、any→`{type:'any'}`、tool→`{type:'tool',name}`、none→`{type:'none'}`;未提供则不带该字段
- [x] 1.4 工具消息映射 `#toToolMessages`:assistant.toolCalls → assistant `tool_use` 块;'tool'.toolResults → user `tool_result` 块(tool_use_id 对齐);其余照旧（纯文本 `#toTextMessages` 不动）

## 2. completeWithTools（非流式）

- [x] 2.1 `messages.create` 带 tools/tool_choice
- [x] 2.2 解析 response `content` 的 `tool_use` 块 → `ToolCall[]`（id/name/input,容错 `{}`）
- [x] 2.3 `stop_reason==='tool_use'` 或聚合出工具调用 → stopReason 'tool_use' 否则 'end'；text 取所有 text 块拼接
- [x] 2.4 无 tool_use 时降级为纯文本 end

## 3. streamWithTools（Anthropic SSE）

- [x] 3.1 `messages.stream`;`content_block_delta` 的 `text_delta` → emit `text`
- [x] 3.2 `content_block_start`(tool_use 块)记 id/name;`input_json_delta` 按 `index` 聚合 partial_json 分片
- [x] 3.3 结束逐个 emit `tool_use`（`tolerantJsonParse(buf)`，空→`{}`），最后 emit `end`（有工具→'tool_use' 否则 'end'）
- [x] 3.4 input JSON 解析失败容错（退化 `{}`），不中断流

## 4. 测试（packages/providers/test，mock 模拟 Anthropic 响应/SSE）

- [x] 4.1 completeWithTools:tool_use 块 → ToolCall + stopReason 'tool_use'；input 容错
- [x] 4.2 completeWithTools:无 tool_use → 纯文本 end
- [x] 4.3 streamWithTools:text_delta + 跨事件 input_json_delta 聚合 → text 事件 + 聚合 tool_use + end('tool_use')
- [x] 4.4 streamWithTools:纯文本流 → text + end('end')
- [x] 4.5 tool_choice 四态映射断言；请求体含 Anthropic tools 形态
- [x] 4.6 回灌:assistant.toolCalls → assistant tool_use 块;'tool'.toolResults → user tool_result 块(tool_use_id 对齐)
- [x] 4.7 向后兼容:纯文本 stream/complete 请求不含 tools/tool_choice，消息映射不变

## 5. 验收

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 5.2 worktree 根 `npx vitest run` 全绿
- [x] 5.3 `openspec validate anthropic-tool-channel --strict` 通过
