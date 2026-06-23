# Design — anthropic-tool-channel

## 背景与对称性

`OpenAiCompatLlm`(上一批)已把 OpenAI function calling 映射进既有接缝,手法可逐行参照:tools/tool_choice 请求构造、SSE 分片聚合、tool 往返回灌、容错降级。本切片对 `AnthropicLlm` 做**同一接缝、不同线缆**的对称实现——区别仅在于走 **Anthropic 原生 tool-use**(SDK `@anthropic-ai/sdk`)而非 HTTP/OpenAI 形态。

## 关键映射(Anthropic 原生 ↔ 接缝)

### 请求:tools / tool_choice
- `LlmToolDef{name,description,inputSchema}` → Anthropic `Tool{name, description, input_schema: inputSchema}`(SDK `Tool.input_schema` 形如 `{type:'object',...}`,直接透传 `inputSchema`)。
- `LlmToolChoice` → Anthropic `tool_choice`:
  - `auto` → `{type:'auto'}`
  - `any` → `{type:'any'}`
  - `tool` → `{type:'tool', name}`
  - `none` → `{type:'none'}`
- 仅当 `req.tools` 非空才带 `tools`;仅当 `req.toolChoice` 提供才带 `tool_choice`(与 OpenAI 实现一致,未提供则不带字段)。

### 响应:content 块解析(completeWithTools)
- 遍历 `msg.content`:`type==='text'` → 收集到 text 拼接;`type==='tool_use'` → `ToolCall{id, name, input: tolerantInput(block.input)}`。
- Anthropic SDK 的 `tool_use.input` 已是**对象**(非字符串),无需再 parse;但为容错沿用统一策略:对象直接用,字符串走 `tolerantJsonParse`,失败 `{}`。
- stopReason:`msg.stop_reason==='tool_use'` 或聚合出 ≥1 工具调用 → `'tool_use'`;否则 `'end'`(容错降级)。

### 流:SSE 聚合(streamWithTools)
Anthropic 流事件与 OpenAI 不同,按块索引(`index`)聚合:
- `content_block_start`:若 `content_block.type==='tool_use'`,以 `event.index` 建条目,记 `id`/`name`,input 分片缓冲清空。
- `content_block_delta`:
  - `delta.type==='text_delta'` → 立即 emit `{type:'text', text}`。
  - `delta.type==='input_json_delta'` → 把 `delta.partial_json` 追加到对应 `index` 的 input 缓冲。
- 流结束(SDK 异步迭代耗尽):按出现顺序逐个 emit `tool_use`(`input = tolerantJsonParse(buf)`,空缓冲→`{}`),最后 emit `end`(有工具→`'tool_use'` 否则 `'end'`)。
- 单事件异常不应中断流(防御 try/catch 思路与 OpenAI 实现一致;SDK 已是强类型事件,主要防 input JSON 解析失败)。

### 回灌:工具往返消息映射
Anthropic 文本通道仅接受 user/assistant 角色 + 字符串内容(现状 `#toTextMessages`)。工具通道需要**块数组**形态:
- assistant 带 `toolCalls` → 一条 assistant 消息,content 为块数组:`[{type:'text',text}(content 非空时), {type:'tool_use', id, name, input}...]`。
- `'tool'` 角色带 `toolResults` → 一条 **user** 消息(Anthropic 把 tool_result 放在 user 回合),content 为 `[{type:'tool_result', tool_use_id, content, is_error?}...]`。
- 普通 user/assistant 文本 → `{role, content: string}` 照旧。
- 该映射仅工具通道用;纯文本 `#toTextMessages` 不动。

> Anthropic 要求 tool_use 块要么有 content 文本要么至少一个块;content 为空字符串时**省略** text 块只保留 tool_use 块,避免发空 text。

## 容错与降级(§3.2)
- input 解析失败 → `{}`,不抛。
- 无 tool_use 块 / `stop_reason` 非 tool_use → 纯文本 `end`,与无工具请求行为一致。
- 纯文本 `stream`/`complete` 路径**零改动**(本切片只新增方法与私有 helper)。

## 测试策略
mock `client.messages.create` / `client.messages.stream`(stub SDK 客户端方法,或注入假 client),用对象/异步可迭代模拟 Anthropic 响应与 SSE 事件:
- completeWithTools:tool_use 块 → ToolCall + stopReason;input 容错;无 tool_use → 文本 end;请求体带 Anthropic tools/tool_choice 形态。
- streamWithTools:text_delta + 跨事件 input_json_delta 聚合 → text + tool_use + end;纯文本流 → text + end。
- tool_choice 四态映射。
- 回灌:assistant.toolCalls → tool_use 块;'tool'.toolResults → user tool_result 块(tool_use_id 对齐)。
- 向后兼容:纯文本 complete/stream 不带 tools/tool_choice,消息映射不变。
