## Context

当前模型侧契约只表达"纯文本回合":

- `packages/protocol/src/chat.ts`:`ChatMessage = { role: 'user'|'assistant'; content: string }`,被 `packages/cognition`(prompt assembler/types)、`packages/memory`(in-memory/sqlite store、types)消费,**全部只读 `.role`/`.content`**。
- `packages/providers/src/llm.ts`:`LlmRequest = { system; messages; maxTokens? }`;`LlmProvider` 有 `stream(req)=>AsyncIterable<string>` 与 `complete(req)=>Promise<string>`。
- `packages/runtime/src/conversation.ts`(**本切片不可改**)直接用 `llm.stream({system,messages})` 收 token 字符串。

§3.3 工具协议为**模型侧 Anthropic 原生 tool-use**。Anthropic 形态(claude-api 技能):工具定义 `{name, description, input_schema(JSON schema)}`;`tool_choice` ∈ auto/any/{type:tool,name}/none;assistant 回复含 `tool_use` 块(`id`/`name`/`input`);工具结果以 `tool_result`(`tool_use_id` + content)回传;流式时 `content_block_start` 带 `tool_use`,随后 `input_json_delta` 增量,文本走 `text_delta`。

## Goals / Non-Goals

**Goals:**
- 把模型侧 tool-use 做成**类型化接缝**:工具定义、请求侧 tools/toolChoice、响应侧 tool_use、回传侧 tool_result。
- `ChatMessage` **纯加法**表达 tool_use/tool_result,既有消费者零改动仍 typecheck(硬性验收:全仓 `pnpm -r typecheck` 绿,且未改其它包)。
- 工具通道**不破坏**既有 `stream(token)=>string` / `complete()=>string`;以新增可选方法表达"文本增量 + tool_use"。
- `FakeLlm` 可脚本化吐 tool_use、可接 tool_result 续写——给未来 Agent loop 一个确定性桩。
- 流式 JSON tool-call 检测纯函数(降级备用)+ 测试。

**Non-Goals:** Agent loop 循环;真 MCP;真 Provider(anthropic/openai-compat)工具线缆;tool_choice 在真模型的强制语义验证。

## Decisions

### D1. ChatMessage 纯加法(向后兼容的核心做法)

保持 `content: string` 必填且语义不变。新增:

```ts
export type ChatRole = 'user' | 'assistant' | 'tool';   // 加 'tool',旧两值不变

export interface ToolCall {            // assistant 发起的 tool_use(承 Anthropic tool_use 块)
  readonly id: string;                 // tool_use_id,回传 tool_result 时对齐
  readonly name: string;
  readonly input: unknown;             // 已解析的入参对象(JSON)
}
export interface ToolResult {          // 回传给模型的工具结果(承 Anthropic tool_result 块)
  readonly toolCallId: string;         // = ToolCall.id
  readonly content: string;
  readonly isError?: boolean;
}
export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;            // **不变**:user/assistant 文本;tool 角色可为""或人类可读摘要
  readonly toolCalls?: readonly ToolCall[];     // 仅 assistant 用;纯加法
  readonly toolResults?: readonly ToolResult[]; // 仅 'tool' 角色用;纯加法
}
```

**为何兼容**:既有代码构造 `{role:'user'|'assistant', content}` 仍满足接口(新字段全可选);`role` 由二元联合扩成三元联合是**加法**(旧值仍合法,且现有 `switch`/`find(m=>m.role==='user')` 等用法不受影响)。`exactOptionalPropertyTypes` 下,可选字段用条件展开,不显式赋 `undefined`。

*备选*:为 tool 角色另立独立类型联合(`ChatMessage | ToolMessage`)。否决:会迫使现有 `readonly ChatMessage[]` 消费者处理新成员,破坏"零改动"。单接口加可选字段最小爆炸半径。

### D2. 请求侧:tools / toolChoice(LlmRequest 加法)

```ts
export interface LlmToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>; // JSON schema(映射 Anthropic input_schema)
}
export type LlmToolChoice =
  | { readonly type: 'auto' }
  | { readonly type: 'any' }
  | { readonly type: 'tool'; readonly name: string }
  | { readonly type: 'none' };

export interface LlmRequest {
  readonly system: string;
  readonly messages: readonly ChatMessage[];
  readonly maxTokens?: number;
  readonly tools?: readonly LlmToolDef[];     // 加法
  readonly toolChoice?: LlmToolChoice;        // 加法
}
```

### D3. 响应/通道:能力标志 + 可选工具方法(Provider 加法)

```ts
export interface ToolUseDelta { readonly type: 'text'; readonly text: string }
                              | { readonly type: 'tool_use'; readonly call: ToolCall };
// 实际以判别联合 LlmStreamEvent 表达(text 增量 / tool_use 调用 / 结束 stopReason)

export interface LlmToolResponse {
  readonly text: string;                       // 拼好的文本
  readonly toolCalls: readonly ToolCall[];     // 本轮模型发起的调用(可空)
  readonly stopReason: 'end' | 'tool_use';
}

export interface LlmProvider {
  readonly id: string; readonly model: string;
  stream(req, signal?): AsyncIterable<string>;        // **不变**
  complete(req, signal?): Promise<string>;            // **不变**
  readonly supportsTools?: boolean;                   // 能力标志,仅 trace/调度参考
  completeWithTools?(req, signal?): Promise<LlmToolResponse>;          // 可选新通道
  streamWithTools?(req, signal?): AsyncIterable<LlmStreamEvent>;       // 可选新通道
}
```

旧 `stream`/`complete` 一字不改 → runtime/conversation.ts 现用法零影响。未实现工具的 Provider 不提供 `supportsTools`/新方法即可(可选)。

### D4. FakeLlm 工具桩

`FakeLlmOptions` 加 `toolScript?`:按"轮次"脚本化产出。一轮可声明:吐文本 + 0..N 个 tool_use 调用(stopReason 据此为 `tool_use`/`end`);若 messages 里已带回 `toolResults`(模拟 Agent loop 回传),则推进到下一脚本轮(可据结果续写)。`completeWithTools` 取该轮聚合;`streamWithTools` 逐 token 吐文本增量再吐 tool_use 事件。`supportsTools = true`。旧 `stream`/`complete` 行为完全保留。

### D5. 流式 JSON tool-call 检测器(降级骨架,加分)

`detectToolCallJson(buffer): {json, rest} | null`:括号配平扫描(复用 json.ts 的平衡思路,字符串/转义感知),从缓冲中切出**首个完整平衡** `{...}`。供本地模型无原生 tool-use 时,从文本流里识别约定的 JSON tool-call。纯函数、确定性、可单测。不接线到任何 Provider(仅备用工具)。

## Risks / Trade-offs

- **向后兼容是硬约束**:任何对 `content` 语义或 `role` 旧值的改动都会级联破坏不可改的包。缓解:纯加法 + `pnpm -r typecheck` 全绿验收。
- **可选方法接缝**:`completeWithTools?` 为可选,调用方需 `?.` 或能力判定;符合"业务对厂商无感、按能力驱动"(§3.1/§3.3)。
- **桩 ≠ 真线缆**:真 Provider 工具实现留后续;本切片只保证接缝形状与 FakeLlm 往返可测。

## Migration Plan

纯加法,无数据/schema 迁移。其它包不动;仅 `packages/protocol`、`packages/providers` 内新增。
