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

`DecisionTrace` SHALL 承载重建一个回合所需的完整决策链:`correlationId`、OTel `traceId`/`spanId`(缝合键)、`sessionId`、`turnId`、时间戳、用户输入、**召回记忆及打分**(文本/kind/subject/hits)、**当时情绪**(emotion 及可得的 PAD)、`assertiveness`、**stance 命中观点**、**最终组装的 system 与 messages**、Provider id 与 model、**LLM 原始回复**、回合延迟。写入 SHALL **无条件全量、不采样**(承"可重放绝不靠 OTel")。本地捕获的完整 prompt SHALL 只落本地 SQLite、绝不导出远端。

#### Scenario: 落库记录可重建该回合

- **WHEN** 一个回合的决策被写入
- **THEN** 该记录含组装出的 system/messages、召回记忆、情绪、stance、Provider/model 与回复,足以回答"她为什么这么说"

#### Scenario: 与 OTel 同 ID 缝合

- **WHEN** 决策被写入且本回合存在 OTel span
- **THEN** 记录中的 `traceId`/`spanId` 与该回合 OTel span 的一致,可由 OTel 跳转回 SQLite

### Requirement: 决策 trace 库版本化与隔离

`SqliteDecisionTraceSink` SHALL 使用独立库文件(默认 `chat-a-trace.db`),其 schema MUST 带版本号并经迁移演进(承 §3.2 数据迁移纪律),MUST NOT 与记忆真相源库耦合或共享表。库路径与启用与否 MUST 由配置驱动(行为即配置,§3.2)。

#### Scenario: 首次启用建库

- **WHEN** 首次以 SQLite sink 启动且库不存在
- **THEN** 按当前版本建表,后续启动按版本号顺序迁移、不丢历史 trace

#### Scenario: 与记忆库分离

- **WHEN** 同时启用记忆库与决策 trace 库
- **THEN** 二者为不同库/表,任一变更不影响另一方

