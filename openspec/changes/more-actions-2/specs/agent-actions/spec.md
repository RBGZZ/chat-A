## ADDED Requirements

### Requirement: 内置本地动作 list_reminders(读提醒)

系统 SHALL 内置一个纯本地动作 `list_reminders`,无入参,读出 `ReminderStore` 中已存的全部提醒(逐条可读)。该动作 MUST 与 `set_reminder` **共享同一注入的 `ReminderStore` 实例**,从而读到 `set_reminder` 写入的提醒。存储为空时 SHALL 返回可读说明(非 `isError`)。该动作 SHALL 声明 `capability: 'time'`(提醒属时间域)。`ReminderStore` MUST 可注入以支持确定性测试。

#### Scenario: 读出已存提醒

- **WHEN** 注入提醒存储,先经 `set_reminder` 写入 `{ text: "喝水" }`,再调用 `list_reminders`(同一存储)
- **THEN** 返回 content 含 "喝水" 的可读列表,`isError` 缺省/false

#### Scenario: 空存储给可读说明

- **WHEN** 注入空提醒存储,调用 `list_reminders`
- **THEN** 返回 content 含"没有提醒"之类可读说明,`isError` 缺省/false

#### Scenario: 声明 time 能力

- **WHEN** 读取 `list_reminders` 动作的 `capability`
- **THEN** 其值为 `'time'`

### Requirement: 内置本地动作 recall_fact(注入回调,不依赖 memory)

系统 SHALL 内置一个纯本地动作 `recall_fact`,入参 `{ query: string }`,经一个**注入的事实查询回调** `(query: string) => string | undefined` 查询并回灌结果。该动作 MUST NOT 依赖 memory 包(只持有注入的函数引用);**缺省回调** SHALL 表达"暂不可用"(查不到)。回调返回空/`undefined` 时 SHALL 返回"没找到/想不起"之类可读结果(属正常未命中,**非** `isError`)。`query` 缺失或为空 SHALL 返回 `isError:true`(不抛)。该动作 SHALL NOT 声明 `capability`(纯本地查询,任何设备可用)。

#### Scenario: 注入回调命中返回结果

- **WHEN** 注入回调对某 query 返回非空字符串,调用 `recall_fact` 传该 query
- **THEN** 返回 content 含回调结果,`isError` 缺省/false

#### Scenario: 未命中返回正常说明(非错误)

- **WHEN** 注入回调对该 query 返回 `undefined`(或使用缺省"暂不可用"回调)
- **THEN** 返回可读的"没找到/想不起"结果,`isError` 缺省/false(非错误)

#### Scenario: 缺 query 返回错误

- **WHEN** 调用 `recall_fact` 缺少 `query` 或 `query` 为空串
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: 不声明 capability

- **WHEN** 读取 `recall_fact` 动作的 `capability`
- **THEN** 其值为 `undefined`

### Requirement: 内置本地动作 countdown(距某时刻还有多久)

系统 SHALL 内置一个纯本地动作 `countdown`,入参 `{ atIso: string }`,返回从"当前时间"到目标 ISO 时刻的剩余时长(可读;目标已过去时给"已过去"说明)。当前时间 MUST 经**注入时钟**取得以支持确定性测试(§3.2)。`atIso` 不可解析为时间 SHALL 返回 `isError:true`(不抛)。该动作 SHALL 声明 `capability: 'time'`(读"现在"属时间域)。

#### Scenario: 未来时刻给出剩余时长

- **WHEN** 注入固定时钟,调用 `countdown` 入参 `atIso` 晚于当前时钟
- **THEN** 返回 content 含正向剩余时长(如天/小时/分),`isError` 缺省/false

#### Scenario: 过去时刻给出已过去说明

- **WHEN** 注入固定时钟,调用 `countdown` 入参 `atIso` 早于当前时钟
- **THEN** 返回 content 含"已过去"之类说明,`isError` 缺省/false

#### Scenario: 不可解析 atIso 返回错误

- **WHEN** 调用 `countdown` 入参 `{ atIso: "not-a-date" }`
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: 声明 time 能力

- **WHEN** 读取 `countdown` 动作的 `capability`
- **THEN** 其值为 `'time'`

### Requirement: 时间域内置动作能力标注

系统 SHALL 给涉及"时间/提醒"的内置动作标注 `capability: 'time'`:`current_time`、`set_reminder`、`list_reminders`、`countdown`。纯计算内置动作(`calculate`、`unit_convert`、`date_diff`、`recall_fact`)SHALL NOT 声明 `capability`(始终可用)。该标注为纯加法:在 `buildDefaultRegistry()` **未配置能力集**时,`toolDefs()` 与 `execute()` 对全部动作的行为与标注前一致(向后兼容)。

#### Scenario: 时间域动作声明 time 能力

- **WHEN** 读取 `current_time`/`set_reminder`/`list_reminders`/`countdown` 的 `capability`
- **THEN** 其值均为 `'time'`

#### Scenario: 纯计算动作不声明能力

- **WHEN** 读取 `calculate`/`unit_convert`/`date_diff`/`recall_fact` 的 `capability`
- **THEN** 其值均为 `undefined`

#### Scenario: 空能力集隐藏时间域动作

- **WHEN** 默认注册表在配置空能力集 `new Set()` 下读取 `toolDefs()`
- **THEN** 工具定义仅含纯计算动作(`calculate`/`unit_convert`/`date_diff`/`recall_fact`),不含 `current_time`/`set_reminder`/`list_reminders`/`countdown`

### Requirement: 默认注册表装配新动作并注入副作用源

`buildDefaultRegistry()` SHALL 注册 `list_reminders`/`recall_fact`/`countdown` 动作,使其经 `toolDefs()` 自动暴露给 tool-use Provider。`list_reminders` SHALL 与 `set_reminder` 复用**同一** `reminderStore`(可经可选项注入);`recall_fact` 的事实查询回调 SHALL 可经 `buildDefaultRegistry` 的可选项(如 `factLookup`)注入;`countdown` SHALL 复用注入的 `now` 时钟。默认(不配能力集)时 `toolDefs()` SHALL 含全部内置动作(向后兼容)。

#### Scenario: 默认注册表含新动作

- **WHEN** 调用 `buildDefaultRegistry()` 并读取 `toolDefs()`
- **THEN** 工具定义集合包含 `current_time`、`calculate`、`set_reminder`、`unit_convert`、`date_diff`、`list_reminders`、`recall_fact`、`countdown`

#### Scenario: list_reminders 与 set_reminder 共享存储

- **WHEN** 经 `buildDefaultRegistry({ reminderStore })` 注入同一存储,先执行 `set_reminder` 再执行 `list_reminders`
- **THEN** `list_reminders` 的结果含 `set_reminder` 刚写入的提醒
