## Why

小雪现在只会"说",不会"做事"。canonical §3.3(模型侧 Agent loop)+ §12.2(行动侧)要让她能执行本地动作(查时间、设提醒、播放控制…)——从"谈话助手"迈向"会替你做事的伴侣"。前置已全部就位:`provider-tooling`(tool-use 抽象 + completeWithTools + FakeLlm 工具桩)与 `turn-strategy`(回合策略接缝)上一批刚落地。本切片把两者接起来,落地**最小可用的 Agent loop + 本地动作框架**(纯本地、不接真 MCP)。

## What Changes

- **新增 `@chat-a/interaction` 包(行动侧接缝,§12.2)**:
  - `Action` 接缝:`{ name, description, inputSchema(JSON schema), perform(input): Promise<ActionResult> }`,`ActionResult = { content: string; isError?: boolean }`。
  - `ActionRegistry`:注册动作;`toolDefs(): LlmToolDef[]`(喂给 tool-use Provider);`execute(call: ToolCall): Promise<ToolResult>`——**执行容错**:未知工具/入参非法/perform 抛错都映射为 `isError:true` 的 `ToolResult`,**绝不抛**(§3.2)。
  - 内置本地动作:`current_time`(时钟可注入,确定性可测)等 1–2 个示例;框架可平凡扩充。
- **新增 `ToolCallingStrategy`(实现已落地的 `TurnStrategy`,挂同一 `Conversation` 外壳)**:
  - 组装 system(复用现有 assembler/persona/stance,与 SingleShot 同)→ **工具循环**:`provider.completeWithTools({system,messages,tools})` → 若 `stopReason==='tool_use'` 则 `registry.execute` 每个调用 → 把 assistant(toolCalls)+ tool(toolResults)追加进工作消息 → 续跑;直到文本回复或 **max iterations 上限**(防死循环)。最终文本经 `onToken` 输出。
  - 回合收尾(落记忆/人格演进/决策trace)与 SingleShot 一致——把 SingleShot 的共享 helper **抽到模块级复用,不重复**。
  - **优雅降级**:`provider.supportsTools !== true`、无 `completeWithTools`、或注册表为空 → 委托回 `SingleShotStrategy`(行为等价当前)。
- **cli 接通**:`CHAT_A_STRATEGY=tools` 启用 ToolCallingStrategy(默认仍 SingleShot);横幅显示策略 + 动作数。

Non-goals(本切片不做):

- **真 MCP client / ProcessSupervisor / 跨进程能力(§12.3)**:卡 §11 待决项(MCP 进程清单 + stdio/HTTP);本期只纯本地内置动作,用 FakeLlm toolScript 桩 + 内存动作测全程往返。
- **感知侧 PerceptionSource(§12.1)**:另开。
- **流式工具中间轮**:MVP 用非流式 `completeWithTools` 跑循环,最终文本一次性 emit(流式工具通道留后续)。
- **prompt 模式降级的实际接线**:`detectToolCallJson` 已在,但本期 ToolCallingStrategy 只走原生 tool-use;无 tools 能力直接降级回 SingleShot。

## Capabilities

### New Capabilities
- `agent-actions`: 小雪经 Agent loop 调用本地动作的能力——`Action`/`ActionRegistry`(容错执行 + toolDefs)、内置本地动作、`ToolCallingStrategy`(工具循环 + max iterations + 降级回 SingleShot)。

### Modified Capabilities
<!-- 无:ToolCallingStrategy 是既有 turn-strategy 接缝的又一实现,不改其需求;复用为内部重构 -->

## Impact

- **延迟预算(§3.2)**:无工具调用的回合**等价当前**(降级或 0 轮工具循环);有工具调用时每轮多一次 LLM 往返——这是 Agent loop 固有成本,max iterations 封顶,且默认策略仍是 SingleShot(opt-in)。
- 代码:
  - 新包 `@chat-a/interaction`(Action/ActionRegistry/内置动作 + 测试)。
  - `@chat-a/runtime`:抽出共享回合 helper(composeSystem/detectStance/writeMemories/recordTrace + 收尾)供两策略复用;新增 `ToolCallingStrategy`。
  - `@chat-a/client`:`CHAT_A_STRATEGY=tools` 装配 + 横幅。
- 依赖:interaction 依赖 `@chat-a/protocol`(ToolCall/ToolResult)+ `@chat-a/providers`(LlmToolDef 类型);runtime 依赖 interaction。无第三方新依赖(JSON schema 用普通对象,入参校验本期做轻量必填/类型检查,Zod 留后续)。
- 已锁决策遵循:Anthropic 原生 tool-use(§3.3)、接缝边界、优雅降级、行为即配置、可重放(工具回合同样落决策 trace)。
