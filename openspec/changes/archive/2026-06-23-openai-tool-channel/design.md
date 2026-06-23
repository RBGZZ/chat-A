## Context

`OpenAiCompatLlm`(`packages/providers/src/openai-compat-llm.ts`)是 OpenAI 兼容端点(DeepSeek 等)的 Provider,目前仅实现纯文本 `stream`/`complete`。接缝 `LlmProvider`(`llm.ts`)已定义工具通道契约(`supportsTools?`、`completeWithTools?→LlmToolResponse`、`streamWithTools?→AsyncIterable<LlmStreamEvent>`),`FakeLlm` 已落地桩,`tool-json.ts`/`json.ts` 提供容错 JSON。本切片把 OpenAI function calling 映射到该契约。

约束:exactOptionalPropertyTypes 开;只改 `packages/providers/**`;不改接缝/Fake/Anthropic 现有契约;纯文本路径不变。

## Goals / Non-Goals

- Goals:OpenAiCompatLlm 实现 `supportsTools=true` + `completeWithTools` + `streamWithTools`,含 tools/tool_choice 请求构造、tool_calls 解析、SSE 工具分片聚合、tool_use/tool_result 回灌、容错降级。
- Non-Goals:Agent loop、真 MCP、Anthropic 工具线缆、并行执行/重试。

## Decisions

### 决策 1:工具通道独立的消息映射,不动纯文本路径
纯文本 `stream`/`complete` 用 `#buildMessages`(把非 assistant 含 'tool' 归并为 user)。工具通道新增 `#buildToolMessages`:assistant 带 `toolCalls` → OpenAI assistant `{content, tool_calls:[{id,type:'function',function:{name,arguments:JSON.stringify(input)}}]}`;`'tool'` 角色每个 `toolResults` 项 → 一条 `{role:'tool',tool_call_id,content}` 消息。其余 user/assistant 文本照旧。这样两条路径互不影响,§3.2 旧路径零改动。

### 决策 2:tool_choice 映射
`auto`→`'auto'`;`any`→`'required'`(OpenAI 语义:必须调用某工具);`tool`→`{type:'function',function:{name}}`;`none`→`'none'`。未提供 `toolChoice` 时不带该字段(端点默认 auto)。

### 决策 3:arguments 用 tolerantJsonParse 容错
OpenAI `tool_calls[].function.arguments` 是 JSON 字符串。用 `tolerantJsonParse` 解析为 `input`;解析为 null 时退化为 `{}`(不抛),保证 Agent loop 能拿到结构化但安全的入参。

### 决策 4:SSE 工具分片按 index 聚合
流式时 `delta.tool_calls` 是分片数组,每项带 `index`(同一工具调用跨多个 chunk 用同 index)、首片带 `id`/`function.name`、后续片追加 `function.arguments`。用 `Map<index, {id,name,args}>` 聚合;`delta.content` 立即 emit `text` 事件;`[DONE]`/流结束时把聚合的工具调用 `tolerantJsonParse(args)` 后逐个 emit `tool_use`,最后 emit `end`(有工具调用→`tool_use`,否则 `end`)。

### 决策 5:容错降级
- HTTP 非 2xx:与现有 `complete`/`stream` 一致抛错(让上层感知配置/网络问题)。
- 解析层:`message.tool_calls` 缺失/空 → `toolCalls:[]`、`stopReason:'end'`(纯文本)。SSE 单片解析失败 → 跳过该片(沿用 `extractDelta` 的 try/catch 风格),不中断流。

## Risks / Trade-offs

- `finish_reason` 各端点略有差异(有的用 `tool_calls`,有的流式不回 finish_reason):故停因以"是否聚合出工具调用"为准更稳健,`finish_reason==='tool_calls'` 仅作 complete 路径的辅助判定。
- `any`→`'required'`:个别老端点不支持 `required`,属端点能力问题,不在本切片兜底范围(Non-goal)。

## Migration Plan

纯加法,无数据迁移。新增可选方法,旧调用方零改动。

## Open Questions

无。
