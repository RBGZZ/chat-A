## 1. 新包 @chat-a/interaction(行动侧)

- [x] 1.1 建包骨架:`packages/interaction/{package.json,tsconfig.json,src/index.ts}`;加入 pnpm workspace;依赖 `@chat-a/protocol` + `@chat-a/providers`(workspace:*)
- [x] 1.2 `src/types.ts`:`ActionResult = { content: string; isError?: boolean }`;`Action = { name; description; inputSchema: Readonly<Record<string,unknown>>; perform(input: unknown): Promise<ActionResult> }`
- [x] 1.3 `src/registry.ts`:`ActionRegistry`——`register`/`toolDefs(): LlmToolDef[]`/`execute(call: ToolCall): Promise<ToolResult>`(容错:未知工具/轻量入参校验失败/perform 抛错 → isError ToolResult,toolCallId 对齐,绝不抛);轻量校验按 inputSchema 的 required/properties 粗检
- [x] 1.4 `src/actions/current-time.ts`:内置 `current_time` 动作(时钟 `now()` 注入,默认 `() => new Date()`);`buildDefaultRegistry(opts?)` 工厂注册内置动作
- [x] 1.5 `src/index.ts` 导出;`pnpm install` 链接

## 2. 抽出共享回合 helper(runtime,重构零行为变更)

- [x] 2.1 `runtime/src/turn-shared.ts`:把 SingleShot 的 `composeSystem`/`detectStance`/`writeMemories`/`recordTrace` 提为模块级纯函数(吃 `TurnDeps` + 参数);把收尾块(appendMessage user/assistant、persona.advance 容错、writeMemories、recordTrace)提为 `finalizeTurn(...)` helper
- [x] 2.2 改 `SingleShotStrategy` 调用共享 helper(行为逐字不变);**现有 runtime 测试全过**(对外等价回归网)

## 3. ToolCallingStrategy(runtime)

- [x] 3.1 `runtime/src/tool-calling-strategy.ts`:`ToolCallingStrategy implements TurnStrategy`,构造 `{ registry, fallback?=new SingleShotStrategy(), maxIters?=5 }`(maxIters 外置常量)
- [x] 3.2 `run(ctx)`:开头降级判断——`llm.supportsTools !== true || !llm.completeWithTools || registry.toolDefs() 空` → `return fallback.run(ctx)`
- [x] 3.3 工具循环:复用共享 helper 组装 system+初始 messages;`completeWithTools` 循环(stopReason==='tool_use' → registry.execute 每调用 → 回灌 assistant(toolCalls)+tool(toolResults)→续);达 maxIters 兜底收尾;最终文本经 `onToken` 输出;外层一个 `llm` span(记 iter 数)
- [x] 3.4 收尾复用 `finalizeTurn`(落消息/advance/writeMemories/recordTrace,与 SingleShot 一致;trace 记最终 messages/reply)
- [x] 3.5 `runtime/index.ts` 导出 `ToolCallingStrategy`;runtime `package.json` 依赖 `@chat-a/interaction`

## 4. cli 接通

- [x] 4.1 `client/cli.ts`:`CHAT_A_STRATEGY=tools` → `new ToolCallingStrategy({ registry: buildDefaultRegistry() })` 传 `strategy`;默认不传(SingleShot)
- [x] 4.2 横幅显示 `策略=${tools|single} 动作=${N}`

## 5. 测试

- [x] 5.1 interaction:`current_time` 注入时钟→确定性;registry `execute` 三态(成功 / 未知工具 isError / perform 抛错 isError 不抛);`toolDefs()` 形态正确;轻量校验缺必填→isError
- [x] 5.2 `ToolCallingStrategy` 全程往返:FakeLlm toolScript [第1轮 tool_use(current_time) → 第2轮文本],断言工具被执行 + 结果回灌 + 最终文本经 onToken + 作为返回值
- [x] 5.3 max iters:toolScript 持续 tool_use 超上限 → 在上限停、返回兜底文本、不无限循环
- [x] 5.4 降级:supportsTools 假 / 空注册表 → 走 SingleShot(产出正常文本,行为等价)
- [x] 5.5 工具回合落 trace:注入 spy traceSink → 工具回合 record 一次,含最终 messages/reply
- [x] 5.6 回归:现有 runtime 全部测试(conversation/persona-turn/decision-trace-turn/prompt-assembly/turn-strategy/tracing/bus)零改动全过(共享 helper 抽出后 SingleShot 对外等价)

## 6. 文档与收尾

- [x] 6.1 `start.bat`/说明:`CHAT_A_STRATEGY=tools` 用法 + 内置动作说明
- [x] 6.2 全量 `pnpm -r typecheck` + `npx vitest run` 通过;手动冒烟:`CHAT_A_STRATEGY=tools` + FakeLLM 工具脚本(或问"现在几点")→ 走工具循环、横幅显示 tools/动作数
