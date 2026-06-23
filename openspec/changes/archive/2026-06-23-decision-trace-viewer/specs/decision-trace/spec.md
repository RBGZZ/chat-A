## ADDED Requirements

### Requirement: 决策 trace 只读查询接缝

系统 SHALL 提供只读 `DecisionTraceReader`,以**只读**方式打开决策 trace 库(默认 `chat-a-trace.db`,路径由配置驱动),提供:列出最近 N 回合(可按 `sessionId` 过滤,返回 turnId / 时间 / 用户输入摘要 / reply 摘要 + 缝合键),以及按 `turnId` / `correlationId` / `trace_id` 取单回合**完整决策链**(JSON 列解析回对象,标量列还原为 `DecisionTrace` 形状)。reader MUST 纯只读——MUST NOT 改写、建表、迁移或以任何方式触碰 `SqliteDecisionTraceSink` 的写路径与契约(单向:库 → reader)。

#### Scenario: 列出最近回合

- **WHEN** 库内已有若干回合且调用列出最近 N 回合
- **THEN** 返回按时间倒序的至多 N 条摘要,每条含 turnId、时间、用户输入摘要与 reply 摘要

#### Scenario: 按 sessionId 过滤

- **WHEN** 以某 `sessionId` 调用列出最近回合
- **THEN** 仅返回该会话的回合,其它会话的回合不出现

#### Scenario: 按标识取单回合完整决策链

- **WHEN** 以某回合的 `turnId`(或 `correlationId` / `trace_id`)取单回合
- **THEN** 返回该回合还原后的 `DecisionTrace`,其 recalled / messages / pad / stanceNotions 等 JSON 列已解析回对象,标量列一致

### Requirement: 只读查询的优雅降级

`DecisionTraceReader` 在库文件不存在、表缺失或库损坏时 MUST 优雅降级:列出操作返回空结果,取单回合返回未命中(undefined),并经告警回调记录(默认 `console.warn`),MUST NOT 抛出以致崩溃。

#### Scenario: 库不存在返回空结果

- **WHEN** 指向一个不存在的库文件并调用列出最近回合
- **THEN** 返回空结果且不抛错,经告警回调记录一次

#### Scenario: 取单回合未命中

- **WHEN** 以一个库中不存在的标识取单回合
- **THEN** 返回未命中(undefined)且不抛错

### Requirement: 决策 trace 回合查看工具

系统 SHALL 提供独立 CLI(observability 包内,经 package.json `bin`/`scripts` 暴露)用于查看决策 trace:一个子命令列出最近回合,另一个子命令按标识把单回合的**召回+打分、情绪与 PAD、assertiveness 与 stance、最终 system prompt、provider+model、reply、posture** 漂亮打印(中文)。库路径 MUST 由配置驱动(命令行参数 / 环境变量 / 默认值),CLI MUST NOT 修改 `packages/client` 或写入 trace 库。

#### Scenario: 列出最近回合

- **WHEN** 运行列出子命令
- **THEN** 以可读形式打印最近若干回合的摘要(时间 / turnId / 用户摘要 / reply 摘要)

#### Scenario: 漂亮打印单回合决策链

- **WHEN** 以某回合标识运行查看子命令
- **THEN** 中文分块打印该回合的召回打分、情绪PAD、stance、最终 system prompt、provider+model 与 reply

#### Scenario: 库不存在时不崩

- **WHEN** 指向不存在的库运行 CLI
- **THEN** 打印友好提示而非崩栈,进程正常退出
