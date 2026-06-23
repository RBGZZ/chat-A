## Why

小雪现在的 Agent loop(§3.3 / §12.2)只有一个内置动作 `current_time`,"会做的事"太少。canonical §12.2 要把行动侧逐步扩成"会替你做事的伴侣"。本切片在**纯本地、无外部进程**的前提下补几个高频小动作——把"能算/能记"这类确定性能力交给代码而非 LLM(§3.2「能用代码算的绝不交给 LLM」),同时避开真 MCP / 跨进程能力(卡 §11 待决项)。

前置已就位:`Action`/`ActionRegistry`(容错执行 + `toolDefs()`)、`buildDefaultRegistry()`、轻量入参校验都在 `@chat-a/interaction`。新动作经 `ActionRegistry.toolDefs()` 自动喂给 `ToolCallingStrategy`,**无需改 runtime/cli**。

## What Changes

- **新增内置本地动作(`@chat-a/interaction`,§12.2)**,均纯本地、无外部进程、副作用源可注入:
  - `calculate`:简单四则运算。入参支持两种形态——`{ expression }`(如 `"3 + 4 * 2"`)或结构化 `{ a, op, b }`;**只支持 `+ - * /`**;**不使用 `eval`**(自写一个最小的、仅识别数字与四则/括号的解析器);除以零 → `isError`。
  - `set_reminder`(**内存版**):入参 `{ text, atIso? }`;把提醒存进**进程内列表** + 提供 `listReminders()` 读取;**到点回调留接口但不接调度**(无副作用到外部);存储后端可注入便于确定性测试。
  - `unit_convert`:固定结构的单位换算(长度/质量/温度等固定换算表的子集),入参 `{ value, from, to }`;不认识的单位对 → `isError`。
- 在 `buildDefaultRegistry()` 注册这三个新动作(`calculate`/`set_reminder`/`unit_convert`)。`set_reminder` 的提醒存储可经 `buildDefaultRegistry({ reminderStore })` 注入。

Non-goals(本切片不做):

- **真 MCP client / ProcessSupervisor / 跨进程能力(§12.3)**:卡 §11 待决项;本期只纯本地内置动作。
- **提醒的实际调度/触发**:`set_reminder` 仅入列 + 列表读取 + 预留回调接口;**不接定时器/事件总线**(避免本期引入跨模块副作用)。
- **改 runtime/cli/其它任何包**:新动作经 `toolDefs()` 自动暴露,无需碰别的包。
- **重量级表达式语言 / 任意精度**:`calculate` 只做有限四则 + 括号,IEEE754 浮点即可。

## Capabilities

### New Capabilities
<!-- 无新增能力域:这些动作落在既有 agent-actions 能力域内 -->

### Modified Capabilities
- `agent-actions`: 在既有"Action 接缝与本地动作"能力域内追加三个内置本地动作(`calculate`/`set_reminder`/`unit_convert`)的需求与场景。

## Impact

- **延迟预算(§3.2)**:这些动作纯本地、同步级开销,对回合延迟无实质影响;它们把"算术/换算"从 LLM 往返里拿掉,反而更快更准。
- 代码:
  - `@chat-a/interaction`:新增 `src/actions/{calculate,set-reminder,unit-convert}.ts` + 测试;`buildDefaultRegistry` 注册并支持注入提醒存储。
  - **不改其它任何包**(runtime/cli/memory/persona/observability 均零改动)。
- 依赖:无第三方新依赖(JSON schema 用普通对象;表达式自解析,不引库)。
- 已锁决策遵循:Anthropic 原生 tool-use(§3.3)、接缝边界、优雅降级(动作内部错误收敛为 `isError`,不抛)、行为即配置(换算表/支持运算符外置为常量)、确定性可测(时钟/提醒存储可注入)。
