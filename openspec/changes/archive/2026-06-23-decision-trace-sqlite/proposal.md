## Why

canonical §8.1 把"每个行为可被完整重建"列为**开发期硬要求**(原话「从 P0 起就埋,不是事后补」),并明确「**可重放绝不靠 OTel(采样会丢)→ SQLite 必须无条件全量**」。我们已埋了 OTel 骨架(turn→llm span),但**真相源决策 trace 一直没落库**(§11 待决项)。如今一句回复背后是:召回记忆+打分 → PAD/情绪 → tone → stance 异议 → 组装 prompt → LLM——出现"她为什么这么说"时**无法重建**。每加一层行为(负面姿态、autonomy)盲区只会更痛。现在补这块地基,给后续所有行为层兜底。

## What Changes

- **新增 `DecisionTraceSink` 接缝**(observability):`record(trace)` 同步、**回合结束后**调用(在拿到回复、落记忆之后),不挡流式首字。默认 `NoopDecisionTraceSink`;`SqliteDecisionTraceSink` 用 `node:sqlite`(内置,无新依赖)落本地库。
- **每回合落一条完整决策链**(无条件全量,不采样):`correlationId` + OTel `trace_id/span_id`(缝合键)+ sessionId/turnId + 输入 userText + **召回记忆及打分**(text/kind/subject/hits)+ **当时情绪**(emotion/PAD)+ assertiveness + **stance 命中观点** + **最终组装的 system/messages** + Provider/model + **LLM 原始回复** + 延迟。
- **缝合两层追踪**:决策 trace 存 `trace_id/span_id`,与 OTel span 同 ID——OTel 发现慢回合可跳到 SQLite 看完整决策(§8.1)。
- **回合编排层(Conversation)直接组装富决策记录**喂 sink(**不走 OTel SpanProcessor**——span 属性有损/会采样,违背"无条件全量")。
- **schema 版本化 + 迁移**(承 §3.2),独立库文件(默认 `chat-a-trace.db`),与记忆真相源分库、互不耦合。
- `client`:`CHAT_A_DECISION_TRACE` 开关 + `CHAT_A_DECISION_TRACE_DB` 路径;横幅显示状态。

Non-goals(本切片不做):

- **回放运行器**(从一条 trace 重跑回合复现 bug):本期只**持久化足以重放的数据**,重放工具另开。
- **隐私脱敏接缝**(§8.1 prod 级脱敏/不写 prompt):本期为本地开发,full prompt 只落**本地** SQLite、**绝不导出远端**;脱敏 seam 留待 P2 安全切片(设计中预留位置)。
- **per-stage 细粒度延迟剖面**(stt/tts 等):本期记回合总延迟 + LLM 段;语音阶段随语音轨再加。
- **OTel→SQLite SpanProcessor/Exporter**:本期用编排层直接组装(更全、不采样),不自写 Exporter。

## Capabilities

### New Capabilities
- `decision-trace`: 每回合完整决策链无条件全量落 SQLite 真相源、与 OTel 同 ID 缝合、可重放——含 `DecisionTraceSink` 接缝、Sqlite/Noop 实现、回合编排层组装与写入、schema 版本化。

### Modified Capabilities
<!-- 纯增量:新增接缝 + Conversation 增一个可选 sink 依赖;不改既有 spec 的需求行为 -->

## Impact

- **延迟预算(§3.2)**:trace 在回合**收尾**写(拿到回复之后),与现有记忆落库同位,**不挡首字**;sink 抛错兜底不打断回合。
- 代码:
  - `@chat-a/observability`:新增 `DecisionTrace` 类型 + `DecisionTraceSink` 接缝 + `NoopDecisionTraceSink` + `SqliteDecisionTraceSink`(node:sqlite,版本化 schema)。
  - `@chat-a/runtime` `Conversation`:`ConversationDeps` 增 `traceSink?`;回合内累积各阶段数据,收尾 `record(...)`;读 turnSpan 的 trace_id/span_id 缝合。
  - `@chat-a/client` `cli.ts`:按 `CHAT_A_DECISION_TRACE` 装配 sink + 横幅。
- 数据:**独立库**(`chat-a-trace.db`),不动记忆库 schema;trace 库自带版本+迁移。
- 已锁决策:契约/接缝哲学、单一真相源、延迟预算、行为即配置均遵循;解决 §11 待决项"OTel→SQLite 落地"(以编排层组装替代自写 SpanProcessor,理由:无损+不采样)。
