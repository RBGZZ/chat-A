## 1. 接缝与类型（observability）

- [x] 1.1 `observability/src/decision-trace.ts`:`DecisionTrace` 类型(correlationId/traceId?/spanId?/sessionId/turnId/createdAtMs/latencyMs/userText/recalled[]/emotion/pad?/assertiveness/stanceNotions[]/system/messages[]/provider/model/reply)+ `DecisionTraceSink` 接缝(`record(trace): void`)
- [x] 1.2 `NoopDecisionTraceSink`(默认,不写)
- [x] 1.3 `observability/src/index.ts` 导出类型 + 实现

## 2. SqliteDecisionTraceSink

- [x] 2.1 `observability/src/sqlite-decision-trace.ts`:`node:sqlite` DatabaseSync 打开独立库(默认 `chat-a-trace.db`);`schema_version` 表 + 顺序迁移(IF NOT EXISTS 幂等),建 `decision_traces`(标量列 + recalled/messages/pad/stance_notions 用 JSON 文本列)+ 索引 correlation_id/session_id
- [x] 2.2 `record(trace)`:序列化 JSON 列 + INSERT;内部 try/catch 自吞(不抛,§3.2);`close()` 释放句柄
- [x] 2.3 工厂 `createDecisionTraceSinkFromEnv`(或在 client 内装配):`CHAT_A_DECISION_TRACE` 开关 + `CHAT_A_DECISION_TRACE_DB` 路径;缺省 Noop

## 3. 回合接线（runtime）

- [x] 3.1 `runtime/conversation.ts`:`ConversationDeps` 增 `traceSink?: DecisionTraceSink`;构造期默认 `NoopDecisionTraceSink`
- [x] 3.2 回合内累积决策数据:userText、recalled(map text/kind/subject/hits)、emotion(mood)、assertiveness、stanceNotions、组装后的 system/messages、provider id+model、reply;记 createdAt + latency(回合起止)
- [x] 3.3 取 turnSpan `spanContext()` 的 traceId/spanId 填入(无效则 undefined),correlationId 一并;**收尾**(取得 reply、落记忆后)调 `traceSink.record(...)`,外层 try/catch 兜底不打断回合
- [x] 3.4 确认 record 在流式首字之后发生(不增首字延迟)

## 4. client 装配

- [x] 4.1 `client/cli.ts`:按 `CHAT_A_DECISION_TRACE` 装配 SqliteDecisionTraceSink(传 `CHAT_A_DECISION_TRACE_DB`),默认 Noop;传入 Conversation
- [x] 4.2 横幅显示决策 trace 状态(off / 库路径);退出时 `close()` sink(若有)

## 5. 测试

- [x] 5.1 `SqliteDecisionTraceSink`:record 后能查回该行,标量 + JSON 列(recalled/messages)往返一致;版本化建库 + 重开迁移幂等
- [x] 5.2 `record` 内部失败(如只读库/坏路径)→ 不抛(自吞降级)
- [x] 5.3 `Conversation`:注入 spy sink → 收尾被调用一次,trace 含组装 system、recalled、emotion、stanceNotions、provider/model、reply 等关键字段
- [x] 5.4 `Conversation`:sink.record 抛错 → 回合仍正常返回回复(降级,§3.2);Noop 默认时行为与现状一致
- [x] 5.5 缝合:有 OTel 时 trace 的 traceId/spanId 非空且与回合 span 一致(可在 initTelemetry 下断言)

## 6. 文档与收尾

- [x] 6.1 `start.bat`/说明:`CHAT_A_DECISION_TRACE` / `CHAT_A_DECISION_TRACE_DB`,与 `CHAT_A_TRACE`(OTel)区别、同 ID 缝合
- [x] 6.2 `.gitignore` 忽略 `chat-a-trace.db`(同记忆库,运行期数据)
- [x] 6.3 全量 `pnpm typecheck` + `pnpm test` 通过;手动冒烟:开 trace + OTel 跑一回合 → 库里有一行、含完整 system/recalled/reply,trace_id 与控制台 span 一致
