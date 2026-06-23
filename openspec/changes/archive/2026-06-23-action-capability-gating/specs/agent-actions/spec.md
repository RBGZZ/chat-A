## ADDED Requirements

### Requirement: Action 可声明所需能力

`Action` 接缝 SHALL 新增**可选**字段 `capability?: string`,声明该动作执行所需的设备/环境能力标签(如 `'time'`/`'audio'`)。未声明 `capability` 的动作 SHALL 视为**无需任何能力、始终可用**(§12.2)。该字段为纯加法,既有动作不声明它时行为不变。

#### Scenario: 无 capability 的动作始终可用

- **WHEN** 一个动作未声明 `capability`
- **THEN** 无论注册表是否配置能力集,该动作都被视为已授权

### Requirement: ActionRegistry 当前能力集

`ActionRegistry` SHALL 支持一个可选的"**当前能力集**"`Set<string>`,可经**构造参数**传入,也可经方法(如 `withCapabilities(set)`)设置/更新。当能力集为**未配置**(缺省)时,注册表 SHALL 视**全部**已注册动作为已授权(向后兼容,行为与未引入能力门时逐字一致)。当能力集已配置时,一个动作 SHALL 视为已授权当且仅当:它未声明 `capability`,或其 `capability` 属于当前能力集。

#### Scenario: 缺省能力集全部授权(向后兼容)

- **WHEN** 构造 `ActionRegistry` 时不传能力集
- **THEN** 所有已注册动作均被视为已授权,`toolDefs()` 与 `execute()` 行为与未引入能力门时一致

#### Scenario: 已配置能力集按授权判定

- **WHEN** 注册表配置能力集为 `{'time'}`,某动作声明 `capability:'audio'`
- **THEN** 该动作被视为未授权;声明 `capability:'time'` 或未声明 `capability` 的动作被视为已授权

### Requirement: 能力门隐藏未授权动作的工具定义

当能力集已配置时,`ActionRegistry.toolDefs()` SHALL **只产出已授权动作**的工具定义,从源头对 tool-use Provider 隐藏设备不支持的动作(§12.2)。缺省(未配置能力集)时 `toolDefs()` SHALL 产出全部已注册动作的工具定义(向后兼容)。

#### Scenario: toolDefs 过滤未授权动作

- **WHEN** 能力集为 `{'time'}`,注册了需 `audio` 的动作与无能力要求的动作
- **THEN** `toolDefs()` 不含需 `audio` 的动作,仅含已授权动作

#### Scenario: 缺省 toolDefs 含全部动作

- **WHEN** 未配置能力集
- **THEN** `toolDefs()` 含全部已注册动作

### Requirement: 能力门对未授权动作容错拒绝

当能力集已配置且 `execute(call)` 的目标动作**已注册但未授权**时,`execute` SHALL 返回 `isError:true` 且 `toolCallId` 对齐入参 `id` 的 `ToolResult`(含可读说明),**绝不向上抛**(§3.2)。"未知工具"(动作不存在)与"未授权"(动作存在但能力不足)SHALL 给出可区分的错误说明。缺省(未配置能力集)时 `execute` 对已注册动作的行为不变。

#### Scenario: 未授权动作执行被容错拒绝

- **WHEN** 能力集为 `{'time'}`,`execute` 一个声明 `capability:'audio'` 的已注册动作
- **THEN** 返回 `isError:true`、`toolCallId` 对齐的 `ToolResult`(说明为未授权/能力不足),不抛异常,不调用其 `perform`

#### Scenario: 缺省下已注册动作正常执行

- **WHEN** 未配置能力集,`execute` 一个已注册动作且入参合法
- **THEN** 该动作正常执行,返回非 error 结果(与未引入能力门时一致)

### Requirement: 内置本地动作 date_diff(日期相差)

系统 SHALL 内置一个纯本地、**确定性**动作 `date_diff`,入参 `{ from: string, to: string }`(ISO 日期/时间),返回 `to` 与 `from` 相差的天数。实现 MUST 为确定性(不读 `Date.now()`、不引随机)。`from`/`to` 任一不可解析为时间 SHALL 返回 `isError:true`(不抛)。该动作 SHALL NOT 声明 `capability`(纯计算,任何设备可用)。`buildDefaultRegistry()` SHALL 注册该动作并经 `toolDefs()` 暴露。

#### Scenario: 计算两日期相差天数

- **WHEN** 调用 `date_diff` 入参 `{ from: "2026-06-20", to: "2026-06-23" }`
- **THEN** 返回 content 含相差天数 `3`、`isError` 缺省/false

#### Scenario: 不可解析日期返回错误

- **WHEN** 调用 `date_diff` 入参含不可解析的日期(如 `from: "not-a-date"`)
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: 默认注册表含 date_diff

- **WHEN** 调用 `buildDefaultRegistry()` 并读取 `toolDefs()`
- **THEN** 工具定义集合包含 `date_diff`(且默认无能力集时全部内置动作均可见)
