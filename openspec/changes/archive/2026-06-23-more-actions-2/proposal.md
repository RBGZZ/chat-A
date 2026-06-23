## Why

小雪的行动侧(§3.3 / §12.2)动作仍偏少,且既有内置动作尚未做**能力标注**——能力门(§12.2)虽已就位,但内置动作没有声明各自需要的设备/环境能力,门一开就无法精确区分"纯计算"与"依赖时间/提醒"的动作。本切片继续在**纯本地、确定性(副作用源可注入)**的前提下:

- 补 2-3 个高频小动作(读提醒 / 召回事实 / 倒计时),把"能记/能查/能算"交给代码而非 LLM(§3.2「能用代码算的绝不交给 LLM」);
- 给涉及"时间/提醒"的动作(含既有 `current_time`/`set_reminder` 与新动作)**恰当标注 `capability`**,为能力门铺路(纯计算动作不标 → 始终可用)。

前置已就位:`Action.capability?`、`ActionRegistry`(容错执行 + 能力门 + `toolDefs()`)、`buildDefaultRegistry()`、`ReminderStore`/`InMemoryReminderStore`/`listReminders` 都在 `@chat-a/interaction`。新动作经 `ActionRegistry.toolDefs()` 自动喂给 `ToolCallingStrategy`,**无需改 runtime/cli/其它包**。

## What Changes

- **新增内置本地动作(`@chat-a/interaction`,§12.2)**,均纯本地、无外部进程、副作用源可注入:
  - `list_reminders`:读出 `set_reminder` 存的提醒,**与 `set_reminder` 共享注入的 `ReminderStore`**(同一实例)。无入参;空列表时给可读说明。声明 `capability: 'time'`(提醒属时间域)。
  - `recall_fact`:接受一个**注入的"事实查询"回调** `(query) => string | undefined`;缺省回调返回"暂不可用"——**不依赖 memory 包**(真正接 memory 留后续接线)。入参 `{ query: string }`;回调返回空/undefined → 给"没找到/暂不可用"的可读结果(非 isError,属正常"没查到")。不声明 `capability`(纯本地查询,任何设备可用)。
  - `countdown`:距某 ISO 时间还有多久。入参 `{ atIso: string }`;**时钟注入**(确定性)。返回到目标的剩余时长(可读,含已过期情形)。`atIso` 不可解析 → `isError`(不抛)。声明 `capability: 'time'`(读"现在"属时间域)。
- **能力标注**:给既有 `current_time`、`set_reminder` 标注 `capability: 'time'`;新 `list_reminders`/`countdown` 标 `'time'`;`recall_fact` 与既有纯计算动作(`calculate`/`unit_convert`/`date_diff`)**不标**(纯计算 → 始终授权)。
- 在 `buildDefaultRegistry()` 注册 `list_reminders`/`recall_fact`/`countdown`;`list_reminders` 与 `set_reminder` 用**同一** `reminderStore`;`recall_fact` 的查询回调可经 `buildDefaultRegistry({ factLookup })` 注入;`countdown` 复用注入的 `now` 时钟。

Non-goals(本切片不做):

- **接 memory 包 / 真实事实召回**:`recall_fact` 只用注入回调,缺省"暂不可用";**绝不 import memory/runtime**(保持 interaction 解耦)。
- **提醒的实际调度/触发**:沿用既有"仅入列 + 读取",`list_reminders` 只读,不接定时器/事件总线。
- **改 runtime/cli/其它任何包**:新动作经 `toolDefs()` 自动暴露,无需碰别的包。
- **真 MCP / 跨进程能力(§12.3)**:卡 §11 待决项;本期只纯本地内置动作。

## Capabilities

### Modified Capabilities
- `agent-actions`: 在既有"Action 接缝与本地动作"能力域内追加三个内置本地动作(`list_reminders`/`recall_fact`/`countdown`)的需求与场景,并补"既有/新动作能力标注"的需求。

## Impact

- **延迟预算(§3.2)**:动作纯本地、同步级开销,对回合延迟无实质影响;把"读提醒/算倒计时"从 LLM 往返里拿掉,更快更准。
- 代码:
  - `@chat-a/interaction`:新增 `src/actions/{list-reminders,recall-fact,countdown}.ts` + 测试;`current-time.ts`/`set-reminder.ts` 加 `capability: 'time'`;`buildDefaultRegistry` 注册并支持注入 `factLookup`,`list_reminders` 复用 `reminderStore`。
  - **不改其它任何包**(runtime/cli/memory/persona/observability 均零改动)。
- 依赖:无第三方新依赖。
- 已锁决策遵循:Anthropic 原生 tool-use(§3.3)、接缝边界(interaction 不依赖 memory)、优雅降级(动作内部错误收敛为 `isError`,不抛)、行为即配置(能力标注随动作走)、确定性可测(时钟/提醒存储/事实回调可注入)。
- 向后兼容:`buildDefaultRegistry()` 默认不配能力集 → `toolDefs()`/`execute()` 对全部动作行为不变;新增能力标注仅在调用方**显式开能力门**时生效。
