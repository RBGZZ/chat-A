# decision-trace Specification

## Purpose
TBD - created by archiving change decision-trace-sqlite. Update Purpose after archive.
## Requirements
### Requirement: DecisionTraceSink 接缝

系统 SHALL 提供 `DecisionTraceSink` 接缝:`record(trace: DecisionTrace): void`,由回合编排层在**回合收尾**(已取得回复、已落记忆后)调用。系统 SHALL 提供默认 `NoopDecisionTraceSink`(不写,零成本)与 `SqliteDecisionTraceSink`(落本地 SQLite 真相源)。`record` MUST 不抛出以致中断回合——内部失败 SHALL 自吞并降级(§3.2);写入 MUST 发生在流式首字之后(不增首字延迟,§3.2)。assembler / detector 等下游模块 MUST NOT 依赖此接缝(单向:编排层 → sink)。

#### Scenario: 回合收尾写入一条决策

- **WHEN** 一个回合正常完成
- **THEN** 编排层以该回合的完整决策数据调用一次 `sink.record`

#### Scenario: sink 抛错不打断回合

- **WHEN** `record` 内部写入失败
- **THEN** 回合仍正常返回回复,错误被自吞/记录,不向上抛

#### Scenario: 默认 Noop 零成本

- **WHEN** 未配置 sink
- **THEN** 使用 `NoopDecisionTraceSink`,回合行为与未引入本特性时一致

### Requirement: 决策链完整且无条件全量

`DecisionTrace` SHALL 承载重建一个回合所需的完整决策链:`correlationId`、OTel `traceId`/`spanId`(缝合键)、`sessionId`、`turnId`、时间戳、用户输入、**召回记忆及打分**(文本/kind/subject/hits)、**当时情绪**(emotion 及可得的 PAD)、`assertiveness`、**stance 命中观点**、**当轮负面姿态 `posture`**(sulking/withdrawn,无则空)、**最终组装的 system 与 messages**、Provider id 与 model、**LLM 原始回复**、回合延迟。写入 SHALL **无条件全量、不采样**(承"可重放绝不靠 OTel")。本地捕获的完整 prompt SHALL 只落本地 SQLite、绝不导出远端。

#### Scenario: 落库记录可重建该回合

- **WHEN** 一个回合的决策被写入
- **THEN** 该记录含组装出的 system/messages、召回记忆、情绪、stance、posture、Provider/model 与回复,足以回答"她为什么这么说"

#### Scenario: 与 OTel 同 ID 缝合

- **WHEN** 决策被写入且本回合存在 OTel span
- **THEN** 记录中的 `traceId`/`spanId` 与该回合 OTel span 的一致,可由 OTel 跳转回 SQLite

#### Scenario: 负面姿态随情绪落库

- **WHEN** 某回合处于负面姿态(sulking/withdrawn)且被写入
- **THEN** 记录的 `posture` 为该姿态;无姿态时为空(可空列)

### Requirement: 决策 trace 库版本化与隔离

`SqliteDecisionTraceSink` SHALL 使用独立库文件(默认 `chat-a-trace.db`),其 schema MUST 带版本号并经迁移演进(承 §3.2 数据迁移纪律),MUST NOT 与记忆真相源库耦合或共享表。库路径与启用与否 MUST 由配置驱动(行为即配置,§3.2)。

#### Scenario: 首次启用建库

- **WHEN** 首次以 SQLite sink 启动且库不存在
- **THEN** 按当前版本建表,后续启动按版本号顺序迁移、不丢历史 trace

#### Scenario: 与记忆库分离

- **WHEN** 同时启用记忆库与决策 trace 库
- **THEN** 二者为不同库/表,任一变更不影响另一方

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

