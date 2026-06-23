# agent-actions Specification

## Purpose
TBD - created by archiving change agent-loop-actions. Update Purpose after archive.
## Requirements
### Requirement: Action 接缝与本地动作

系统 SHALL 提供 `Action` 接缝:`{ name, description, inputSchema, perform(input): Promise<ActionResult> }`,`ActionResult = { content: string; isError?: boolean }`。系统 SHALL 内置至少一个纯本地动作(如 `current_time`),其副作用源(如时钟)MUST 可注入以支持确定性测试(§3.2)。

#### Scenario: 内置动作执行返回结果

- **WHEN** 调用一个内置本地动作(如 current_time,注入固定时钟)
- **THEN** 返回确定性的 `ActionResult`(content 非空,isError 缺省/false)

### Requirement: ActionRegistry 容错执行与工具定义

系统 SHALL 提供 `ActionRegistry`:注册 `Action`、`toolDefs()` 产出 `LlmToolDef[]`(name/description/inputSchema,喂给 tool-use Provider)、`execute(call)` 执行一个 `ToolCall` 并返回 `ToolResult`。`execute` MUST **容错**:未知工具、入参校验失败、`perform` 抛错都 SHALL 映射为 `isError:true` 且 `toolCallId` 对齐的 `ToolResult`,**绝不向上抛**(§3.2);成功时 `isError` 缺省/false。

#### Scenario: 已知工具成功执行

- **WHEN** `execute` 一个注册过的工具调用且入参合法
- **THEN** 返回 `isError` 非真、`toolCallId` 对齐入参 `id` 的 `ToolResult`

#### Scenario: 未知工具不抛

- **WHEN** `execute` 一个未注册的工具名
- **THEN** 返回 `isError:true` 的 `ToolResult`(含可读错误说明),不抛异常

#### Scenario: perform 抛错被收敛

- **WHEN** 某工具的 `perform` 抛出异常
- **THEN** `execute` 捕获并返回 `isError:true` 的 `ToolResult`,回合不被中断

### Requirement: ToolCallingStrategy 工具循环与上限

系统 SHALL 提供 `ToolCallingStrategy`(实现 `TurnStrategy`,挂同一 `Conversation` 外壳):组装 system 后跑**工具循环**——经 `provider.completeWithTools` 取回复,若停因为 `tool_use` 则用 `ActionRegistry.execute` 执行每个调用、把 assistant(toolCalls)与 tool(toolResults)消息回灌、续跑,直到产出文本回复。循环 MUST 有**最大轮数上限**(防死循环),达上限即收尾返回当前文本。最终文本 SHALL 经 `onToken` 输出。回合收尾(落消息/人格演进/决策 trace)MUST 与 SingleShot 一致(复用共享逻辑,不另立一套)。

#### Scenario: 模型调用工具后据结果作答

- **WHEN** 模型本轮发起 tool_use、工具返回结果后模型给出文本
- **THEN** 该工具被执行、结果回灌模型,最终文本回复经 onToken 输出且作为回合返回值

#### Scenario: 达到最大轮数上限即收尾

- **WHEN** 模型连续多轮持续发起 tool_use 超过上限
- **THEN** 循环在上限处停止、返回当前已有文本,不无限循环

#### Scenario: 工具回合同样落决策 trace

- **WHEN** 一个含工具调用的回合完成
- **THEN** 该回合的决策 trace 被写入(与 SingleShot 同等的收尾),可重放

### Requirement: 无工具能力时优雅降级

当 `provider.supportsTools !== true`、Provider 未实现 `completeWithTools`、或 `ActionRegistry` 为空时,`ToolCallingStrategy` SHALL 优雅降级——委托回 `SingleShotStrategy`,行为与不启用工具时等价(§3.2),绝不因缺工具能力而报错或空回。

#### Scenario: Provider 不支持工具则走单趟

- **WHEN** 注入的 Provider `supportsTools` 非真
- **THEN** 回合按 SingleShotStrategy 执行(单趟流式),产出正常文本回复

#### Scenario: 空注册表则走单趟

- **WHEN** ActionRegistry 没有任何动作
- **THEN** 回合降级为 SingleShotStrategy,不发起工具循环

