## ADDED Requirements

### Requirement: 内置本地动作 calculate(四则运算)

系统 SHALL 内置一个纯本地动作 `calculate`,做简单四则运算。入参 SHALL 支持两种形态(择一):`{ expression: string }`(如 `"3 + 4 * 2"`)或结构化 `{ a: number, op, b: number }`,`op` 仅 `+`/`-`/`*`/`/`。实现 MUST NOT 使用 `eval`(自写仅识别数字、四则运算符与括号的最小解析)。除以零 SHALL 返回 `isError:true`(不抛)。表达式非法或两种形态均不满足 SHALL 返回 `isError:true`(不抛)。

#### Scenario: 表达式形态按优先级求值

- **WHEN** 调用 `calculate`,入参 `{ expression: "3 + 4 * 2" }`
- **THEN** 返回 content 含结果 `11`、`isError` 缺省/false

#### Scenario: 结构化形态求值

- **WHEN** 调用 `calculate`,入参 `{ a: 6, op: "/", b: 3 }`
- **THEN** 返回 content 含结果 `2`、`isError` 缺省/false

#### Scenario: 除以零返回错误

- **WHEN** 调用 `calculate`,入参表达 `x / 0`(任一形态)
- **THEN** 返回 `isError:true` 的结果(含可读说明),不抛异常

#### Scenario: 非法表达式返回错误

- **WHEN** 调用 `calculate`,入参 `{ expression: "3 + " }` 或含非法字符
- **THEN** 返回 `isError:true` 的结果,不抛异常

### Requirement: 内置本地动作 set_reminder(内存版)

系统 SHALL 内置一个纯本地动作 `set_reminder`,入参 `{ text: string, atIso?: string }`,把提醒存入**进程内**提醒存储(无外部进程副作用)。系统 SHALL 提供读取已存提醒的途径(`listReminders` / store `.list()`)。提醒存储 MUST 可注入以支持确定性测试。`atIso` 若提供且不可解析 SHALL 返回 `isError:true`(不抛)。到点触发回调 MAY 预留接口,但本切片 SHALL NOT 接入任何调度器/定时器。

#### Scenario: 存入提醒后可读取

- **WHEN** 注入提醒存储,调用 `set_reminder` 入参 `{ text: "喝水" }`
- **THEN** 该提醒被加入存储,`listReminders` / `.list()` 能读到 text 为 "喝水" 的条目,返回 `isError` 缺省/false

#### Scenario: 缺必填 text 返回错误

- **WHEN** 调用 `set_reminder` 缺少 `text`
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: atIso 不可解析返回错误

- **WHEN** 调用 `set_reminder` 入参 `{ text: "x", atIso: "not-a-date" }`
- **THEN** 返回 `isError:true` 的结果,不抛异常

### Requirement: 内置本地动作 unit_convert(固定换算)

系统 SHALL 内置一个纯本地动作 `unit_convert`,入参 `{ value: number, from: string, to: string }`,按固定换算表在同一量纲内换算(如长度/质量/温度)。`from`/`to` 为未知单位或属不同量纲 SHALL 返回 `isError:true`(不抛)。换算表 SHALL 作为外置常量(行为即配置,§3.2)。

#### Scenario: 同量纲换算成功

- **WHEN** 调用 `unit_convert` 入参 `{ value: 1000, from: "m", to: "km" }`
- **THEN** 返回 content 含结果 `1`、`isError` 缺省/false

#### Scenario: 未知单位返回错误

- **WHEN** 调用 `unit_convert` 含未知单位(如 `from: "furlong"`)
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: 跨量纲换算返回错误

- **WHEN** 调用 `unit_convert` 入参 `{ value: 1, from: "m", to: "kg" }`
- **THEN** 返回 `isError:true` 的结果,不抛异常

### Requirement: 默认注册表装配新动作

`buildDefaultRegistry()` SHALL 注册上述 `calculate`/`set_reminder`/`unit_convert` 动作,使其经 `toolDefs()` 自动暴露给 tool-use Provider。`set_reminder` 的提醒存储 SHALL 可经 `buildDefaultRegistry` 的可选项注入。

#### Scenario: 默认注册表含新动作

- **WHEN** 调用 `buildDefaultRegistry()` 并读取 `toolDefs()`
- **THEN** 工具定义集合包含 `current_time`、`calculate`、`set_reminder`、`unit_convert`
