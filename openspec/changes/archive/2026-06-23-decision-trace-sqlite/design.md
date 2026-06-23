## Context

§8.1 要"每个行为可被完整重建",且明确两层追踪:**OTel** = 实时/可采样/运维(span 短命、默认不存完整 prompt);**SQLite 决策 trace** = 持久/不采样/单一真相源/可重放(存完整 prompt + 召回打分 + PAD/情绪),二者用同 `trace_id/span_id` 缝合。现状只有 OTel 骨架;`conventions.ts` 已把 `correlation_id` 定为缝合键,但 SQLite 决策 trace 未落。

可复用:`Conversation` 已在 turn span 内持有 userText、recalled(MemoryRecord[]含 hits)、mood(emotion)、stance、组装后的 system/messages、provider id/model、reply、correlationId;`node:sqlite`(memory 已用,内置无依赖)。

约束:延迟预算(收尾写、不挡首字)、接缝边界(编排层→sink 单向)、优雅降级(sink 抛错不打断)、行为即配置(开关/库路径外置)、数据迁移纪律(版本化独立库)。

## Goals / Non-Goals

**Goals:**
- 每回合完整决策链无条件全量落本地 SQLite,与 OTel 同 ID 缝合,足以重放。
- `DecisionTraceSink` 接缝 + Noop/Sqlite 实现;Conversation 收尾写入。
- 独立版本化库,不耦合记忆真相源。

**Non-Goals:**
- 回放运行器(只持久化、不重跑);隐私脱敏接缝(本地 full prompt,P2 再做);per-stage 延迟剖面;OTel SpanProcessor/Exporter 路线。

## Decisions

### D1:编排层直接组装富记录,不走 OTel SpanProcessor

§8.1 原话"可重放绝不靠 OTel(采样会丢)→ SQLite 必须无条件全量"。span 属性有损(大 prompt 不该塞 span)、且会被采样。故由 `Conversation` 在回合内把各阶段数据攒成一个 `DecisionTrace`,收尾喂 sink。**备选**:自写 SpanProcessor 落 span(§11 待决项设想)——属性有损、采样丢数据、还要把完整 prompt 塞 span(被告诫别做),弃。这条**正式收口 §11 的"OTel→SQLite 落地"待决项**。

### D2:DecisionTraceSink 接缝(单向,收尾,容错)

```ts
interface DecisionTraceSink { record(trace: DecisionTrace): void; }
```
同步签名(本地 ms 级写,与记忆落库同位);`Conversation` 在拿到 reply、写完记忆、emit turn:end 前后调用,**首字之后**。`record` 内部 try/catch 自吞(承 §3.2,绝不打断回合)。`NoopDecisionTraceSink` 默认。**单向**:assembler/persona/memory 不感知 sink。

### D3:DecisionTrace 形状(够重放,P1 口径)

```ts
interface DecisionTrace {
  correlationId: string; traceId?: string; spanId?: string;
  sessionId: string; turnId: string; createdAtMs: number; latencyMs: number;
  userText: string;
  recalled: { text: string; kind?: string; subject: string; hits: number }[];
  emotion: string; pad?: { pleasure: number; arousal: number; dominance: number };
  assertiveness: number; stanceNotions: string[];
  system: string; messages: { role: string; content: string }[];
  provider: string; model: string; reply: string;
}
```
召回"打分"P1 即 hits(关键词级);P2 混合召回打分接上后扩展。pad 可选(取决于 persona 暴露)。

### D4:SqliteDecisionTraceSink — 独立库 + 版本化

`node:sqlite` `DatabaseSync`,默认 `chat-a-trace.db`(独立于记忆库)。单表 `decision_traces`,标量列(correlation_id/trace_id/span_id/session_id/turn_id/created_at/latency_ms/emotion/assertiveness/provider/model/user_text/reply/system)+ JSON 列(recalled/messages/pad/stance_notions)。`schema_version` 表 + 顺序迁移(IF NOT EXISTS 幂等),复刻记忆库迁移手法。索引 `correlation_id`、`session_id`。**备选**:塞进记忆库——违背"分库互不耦合"、且 observability 不该依赖 memory 包,弃。

### D5:trace_id/span_id 缝合

`Conversation` 在 turn span 内用 `turnSpan.spanContext()` 取 `traceId`/`spanId` 填进 trace(OTel 未初始化时为占位/无效,写 undefined)。与 `CHAT_A.CORRELATION_ID` 一并构成缝合键。

### D6:启用与默认

`CHAT_A_DECISION_TRACE`(默认 **off**:避免每次跑都生成库文件;开发排查时显式开)、`CHAT_A_DECISION_TRACE_DB`(库路径)。**注**:设计称"无条件全量"指**启用后不采样**,不等于强制常开;启用是配置项。横幅显示状态。**备选**:默认开——会给每次冒烟都建库、略意外,弃(可后续按 dev 环境默认开)。

### D7:observability 落 node:sqlite

sink 放 `@chat-a/observability`(它本就主管两层追踪 + conventions)。`node:sqlite` 内置,无新第三方依赖;observability 不反向依赖 runtime/memory。

## Risks / Trade-offs

- **写入耗时拖慢回合尾** → 收尾同步写、单行、在首字之后;sink 抛错自吞。量级与记忆落库相当。
- **完整 prompt 含敏感记忆落库** → 只落**本地**库、绝不导出远端(承 §8.1 prod 才脱敏);脱敏 seam 位置在设计预留,P2 安全切片补。
- **trace 库膨胀**(每回合一行 + JSON) → P1 可接受;后续加保留窗口/轮转(留待)。
- **默认 off 可能让人忘了开导致排查时无数据** → 横幅明确显示开关状态 + 文档建议开发期打开;后续可按环境默认开。
- **messages 体量大** → P1 存 JSON;若过大,后续可只存增量/裁剪(留待)。

## Migration Plan

1. observability:`DecisionTrace`/`DecisionTraceSink` 类型 + `NoopDecisionTraceSink` + `SqliteDecisionTraceSink`(node:sqlite,版本化 schema)+ 导出。
2. runtime `Conversation`:`traceSink?` 依赖(默认 Noop);回合内累积 recalled/mood/stance/system/messages/reply/timing;收尾 `record`;取 turnSpan spanContext 缝合。
3. client:`CHAT_A_DECISION_TRACE` / `_DB` 装配 + 横幅。
4. 测试:Sqlite sink 写入+读回字段;Conversation 收尾以预期字段调 sink(注入 spy sink);sink 抛错回合不挂(降级);版本化建库/迁移幂等。
5. 文档:env 说明 + start.bat 注释。
6. **回滚**:不设 `CHAT_A_DECISION_TRACE` 即 Noop,完全等价当前;独立库无迁移风险,可安全回退。

## Open Questions

- 默认 off vs dev 默认 on:本期 off,待积累后决定是否 dev 环境默认开。
- `recalled` 的"打分"目前只有 hits(关键词级);P2 混合召回上线后扩展字段,届时 schema +1 迁移。
