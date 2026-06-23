## Context

前置已就位:`provider-tooling`(`LlmRequest.tools`/`toolChoice`、`completeWithTools→LlmToolResponse{text,toolCalls,stopReason}`、`supportsTools`、`LlmToolDef{name,description,inputSchema}`、FakeLlm `toolScript` 桩)与 `turn-strategy`(`TurnStrategy.run(ctx)`、`TurnContext{userText,onToken,turnId,correlationId,turnSpan,turnStartMs,deps}`、`TurnDeps{tracer,llm,memory,persona,sessionId,skeleton,assembler,stanceDetector,selfNotions,assertiveness,expressiveness,extractor,extractEnabled,traceSink}`)。`SingleShotStrategy` 已是 `TurnStrategy` 默认实现,其回合体含 4 个私有 helper(composeSystem/detectStance/writeMemories/recordTrace)+ 收尾块(appendMessage×2、persona.advance、writeMemories、recordTrace)。protocol 有 `ToolCall{id,name,input}`/`ToolResult{toolCallId,content,isError?}`。

约束:接缝边界(§3.1)、优雅降级(§3.2 每步容错)、延迟预算(无工具回合零额外开销)、行为即配置(上限/策略外置)、可重放(工具回合同样落 trace)、Anthropic 原生 tool-use(§3.3)。

## Goals / Non-Goals

**Goals:**
- 纯本地 `Action`/`ActionRegistry`(容错执行 + toolDefs)+ 内置动作。
- `ToolCallingStrategy`:工具循环 + max iterations + 与 SingleShot 一致的收尾(复用)+ 无能力降级回 SingleShot。
- cli `CHAT_A_STRATEGY=tools` 接通。

**Non-Goals:**
- 真 MCP/ProcessSupervisor/感知源(§12.3,卡 §11);流式工具中间轮;Zod 重校验;prompt 模式降级接线。

## Decisions

### D1:新包 `@chat-a/interaction` 承行动侧(§12.2),不塞进 runtime

行动侧是独立关注点(未来要接 MCP、能力门、感知源)。`Action`/`ActionRegistry`/内置动作放新包 `@chat-a/interaction`,依赖 `@chat-a/protocol`(ToolCall/ToolResult)+ `@chat-a/providers`(LlmToolDef 类型)。runtime 依赖 interaction。**备选**:塞 runtime——会让行动侧与回合编排耦合、未来 MCP 难独立,弃。

### D2:`Action` 用普通 JSON schema 对象,入参做轻量校验(Zod 留后续)

`inputSchema: Readonly<Record<string,unknown>>`(直接当 `LlmToolDef.inputSchema`,映射 Anthropic input_schema)。本期入参校验做**轻量必填/类型检查**(按 schema 的 required/properties 粗检),不引 Zod(避免新依赖 + 保持 MVP 小);校验失败 → `isError` ToolResult。**备选**:引 Zod 强校验——留待动作变复杂时再上。

### D3:`ActionRegistry.execute` 全容错,绝不抛(§3.2)

```ts
execute(call: ToolCall): Promise<ToolResult>
// 未知工具 / 入参非法 / perform 抛错 → { toolCallId: call.id, content: <可读错误>, isError: true }
// 成功 → { toolCallId: call.id, content: result.content, isError: result.isError }
```
工具失败是"模型可据此调整"的正常信号,不是回合故障——故收敛成 isError ToolResult 回灌模型,而非中断回合。

### D4:抽出共享回合 helper,两策略复用(不重复)

把 `SingleShotStrategy` 的 `composeSystem`/`detectStance`/`writeMemories`/`recordTrace` 及"收尾块"(appendMessage user/assistant、persona.advance、writeMemories、recordTrace 的组合)抽到模块级 `turn-shared.ts`(纯函数,签名吃 `TurnDeps` + 必要参数)。SingleShot 与 ToolCalling 都调它。**好处**:工具回合的记忆/人格/trace 与单趟**逐字一致**,零漂移;ToolCalling 只替换"LLM 交互"那一段。

### D5:ToolCallingStrategy 工具循环(非流式 + 最终文本 emit)

```
mood/stance/compose 同 SingleShot(复用) → 得 system + 初始 messages
工作 messages = [...messages]
for iter in 0..MAX_TOOL_ITERS:
  resp = await llm.completeWithTools({system, messages: working, tools: registry.toolDefs()})
  if resp.stopReason !== 'tool_use' or resp.toolCalls 空:
     finalText = resp.text; break
  working.push(assistant 消息{content:resp.text, toolCalls})
  results = await Promise.all(resp.toolCalls.map(c => registry.execute(c)))  // 容错,不抛
  working.push(tool 消息{content:'', toolResults: results})
  (达 MAX 上限仍未收尾 → finalText = resp.text 兜底)
onToken(finalText) 一次性输出   // MVP 不流式中间轮
收尾(复用 turn-shared:落消息/advance/writeMemories/recordTrace)
```
`MAX_TOOL_ITERS` 外置常量(默认如 5)。llm span:外层一个 `llm` span 覆盖整个循环(子 attr 记 iter 数),与 SingleShot 的单 llm span 语义对齐。decision trace 的 `messages`/`reply` 记最终态。

### D6:降级回 SingleShot(组合而非继承)

`ToolCallingStrategy` 构造期持有 `registry` + 一个 `fallback: TurnStrategy`(默认 `new SingleShotStrategy()`)。`run(ctx)` 开头判:`ctx.deps.llm.supportsTools !== true || !llm.completeWithTools || registry 为空` → `return this.fallback.run(ctx)`。**组合**优于继承:降级路径与 SingleShot 完全同源、零重复。

### D7:cli/Conversation 接线

`ConversationDeps.strategy?` 已存在(turn-strategy 切片)。cli:`CHAT_A_STRATEGY=tools` 时 `strategy = new ToolCallingStrategy({ registry: buildDefaultRegistry() })`,否则不传(默认 SingleShot)。内置 registry 工厂在 interaction 包。横幅显示 `策略=tools 动作=N`。

## Risks / Trade-offs

- **工具循环增加延迟**(每轮一次 LLM 往返) → Agent loop 固有;默认 off(opt-in),max iterations 封顶,无工具回合零额外开销。
- **非流式最终文本**(MVP 不流式中间轮) → 工具回合首字延迟比单趟高;可接受(动作场景用户预期"她在做事")。流式工具通道 `streamWithTools` 已备,后续切片接。
- **轻量入参校验可能漏掉复杂约束** → 失败安全(isError 回灌模型自纠);Zod 留后续。
- **抽 helper 改 SingleShot 代码** → 行为零变:现有 runtime 测试(对外等价那套)必须全过,作为重构安全网。

## Migration Plan

1. 新包 `@chat-a/interaction`:`Action`/`ActionResult`/`ActionRegistry`(execute 容错 + toolDefs + 轻量校验)+ 内置 `current_time`(时钟注入)+ `buildDefaultRegistry()` + 单测。加 workspace/tsconfig/package.json。
2. `@chat-a/runtime`:抽 `turn-shared.ts`(共享 helper + 收尾),改 `SingleShotStrategy` 调它(行为零变,现有测试全过)。
3. `@chat-a/runtime`:`ToolCallingStrategy`(循环 + max iters + 降级回 SingleShot),导出。runtime 依赖 interaction。
4. `@chat-a/client`:`CHAT_A_STRATEGY=tools` 装配 + 横幅。
5. 测试:registry 容错(未知/非法/抛错)、current_time 确定性、ToolCallingStrategy 全程往返(FakeLlm toolScript:第1轮 tool_use→第2轮文本)、max iters 上限、降级(supportsTools 假/空注册表)、工具回合落 trace、SingleShot 对外等价回归。
6. **回滚**:不设 `CHAT_A_STRATEGY=tools` → 完全等价当前(默认 SingleShot);interaction 包独立,可整体移除。

## Open Questions

- `MAX_TOOL_ITERS` 取值(默认 5?)——外置常量,体感后调。
- 内置动作首批除 current_time 外是否加"设提醒"(需落记忆/调度)——倾向本期只 current_time(纯本地无副作用),提醒留到有调度/autonomy 时;apply 时定。
