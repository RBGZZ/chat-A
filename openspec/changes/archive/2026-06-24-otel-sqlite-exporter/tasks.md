## 1. SpanRecord 类型 + SQLite 落库 sink(接缝 + 数据迁移纪律,§3.1/§3.2)

- [x] 1.1 新增 `packages/observability/src/sqlite-span-trace.ts`:定义 `SpanRecord` 类型(`traceId`/`spanId`/`parentSpanId?`/`name`/`startTimeMs`/`endTimeMs`/`durationMs`/`statusCode`(0/1/2 → unset/ok/error 文本)/`statusMessage?`/GenAI 属性可选:`operationName?`/`provider?`/`model?`/`inputTokens?`/`outputTokens?`/`outputType?`/`conversationId?`/`sessionId?`/`turnId?`/`correlationId?`),全部 readonly;锚定语音真实时刻=用 span 的真实 start/end 墙钟毫秒
- [x] 1.2 在该文件实现 `SqliteSpanSink`(node:sqlite):构造打开库、`PRAGMA journal_mode=WAL`、版本化迁移(独立 `span_meta` KV + 顺序 `MIGRATIONS` + 单事务 BEGIN/COMMIT/ROLLBACK,沿用 `sqlite-decision-trace.ts` 手法);`CURRENT_SPAN_SCHEMA_VERSION=1`;`MIGRATIONS[1]` 建 `otel_spans` 表 + 索引(trace_id、(trace_id,span_id) 唯一)
- [x] 1.3 `recordSpan(span: SpanRecord): void`:`INSERT ... ON CONFLICT(trace_id, span_id) DO UPDATE`(同 span 幂等 upsert);GenAI 可选属性缺省落 NULL;失败走 `#onError`(默认 console.error)不抛(§3.2)
- [x] 1.4 `close()` 释放句柄,失败仅告警;初始化失败必须关句柄(Windows 防锁文件,沿用决策 sink 写法)
- [x] 1.5 只读还原:`getSpansByTraceId(traceId): SpanRecord[]`(按 start 升序)与 `getSpanById(traceId, spanId): SpanRecord | undefined`,供测试断言与 CLI 缝合;NULL 列条件还原(exactOptionalPropertyTypes 友好);表缺失/损坏降级空结果

## 2. 自定义 SpanProcessor / SpanExporter(§8.1 自写实现)

- [x] 2.1 新增 `packages/observability/src/sqlite-span-processor.ts`:实现 `toSpanRecord(span: ReadableSpan): SpanRecord` 纯投影——读 `spanContext()`(trace_id/span_id)、`parentSpanContext?.spanId`、`name`、`startTime`/`endTime`(HrTime `[s,ns]` → 毫秒,墙钟真实时刻)、`duration`(HrTime → ms)、`status.code`/`status.message`、`attributes` 取 GenAI 键(用 `conventions.ts` 的 `GENAI`/`CHAT_A` 常量,不写 magic string)
- [x] 2.2 实现 `SqliteSpanExporter`(`SpanExporter`):`export(spans, resultCallback)` 把每条投影后交 sink.recordSpan,成功回 `{ code: SUCCESS }`;`shutdown()` 调 sink.close;导出**绝不抛**回 SDK
- [x] 2.3 实现 `SqliteSpanProcessor`(`SpanProcessor`):`onStart` 空操作;`onEnd(span)` 把投影后的 record 入**异步队列**(microtask/批量,batchSize 外置),不在 onEnd 同步阻塞写库(§3.2 不拖垮);`forceFlush()` 排空队列;`shutdown()` 排空 + 关 sink;全程吞错记日志
- [x] 2.4 `SqliteSpanProcessorOptions`:`{ sink | path, batchSize?, onError? }`;批量阈值外置默认(如 32),无 magic number

## 3. 采样策略两侧分治 + env 装配(行为即配置,§3.2)

- [x] 3.1 `packages/observability/src/telemetry.ts`:`InitTelemetryOptions` 增可选 `sampler?: Sampler`;`initTelemetry` 把它传入 `NodeTracerProvider({ sampler })`;**不传时默认 `AlwaysOnSampler`**(保证 SQLite processor 拿到全量 span = 不采样真相源);注释写明"OTel 侧降噪应放导出链路,勿用 provider sampler 饿死 SQLite"
- [x] 3.2 `sqlite-span-processor.ts` 增 `createSpanProcessorFromEnv(env=process.env)`:`CHAT_A_OTEL_SPAN_SQLITE`=1/on/true 启用,`CHAT_A_OTEL_SPAN_SQLITE_DB`=库路径(默认 `chat-a-trace.db`,与决策 trace 同库共存),`CHAT_A_OTEL_SPAN_SQLITE_BATCH`=批量;默认关返回 `{ enabled:false }`(零成本);开启返回 `{ enabled:true, processor, dbPath }`
- [x] 3.3 `index.ts` 导出 `sqlite-span-trace`、`sqlite-span-processor`

## 4. CLI 缝合(决策记录 ←→ span 阶段耗时,只读降级)

- [x] 4.1 `packages/observability/src/bin/trace.ts`:`runShow` 命中决策记录且带 `traceId` 时,用 `SqliteSpanSink` 只读还原同 trace 下的 span,打印"span 阶段耗时(name / duration / status)"小节;无 span / 库无表 → 静默跳过(降级不崩),纯只读不建写

## 5. 测试(TDD:先写后实现,确定性、无 LLM,§3.2)

- [x] 5.1 新增 `packages/observability/test/sqlite-span-trace.test.ts`:`recordSpan` 后只读还原往返一致(trace_id/span_id/parent/name/start/end/duration/status/GenAI 属性);可选属性省略 → NULL;同 (trace_id,span_id) 二次 record 幂等 upsert(不重复行);close 后再 record 不抛(自吞);版本化建库 + 重开迁移幂等(schema_version 稳定)
- [x] 5.2 新增 `packages/observability/test/sqlite-span-processor.test.ts`:`toSpanRecord` 投影正确(造 ReadableSpan / 走真 SDK startActiveSpan 设 GenAI 属性 → onEnd → 断言落库字段 + HrTime→ms 正确、parent_span_id 正确);`forceFlush` 后能查回;导出失败(sink 已关/路径非法)`onEnd`/`forceFlush` 不抛(优雅降级)
- [x] 5.3 缝合测试:走 `initTelemetry({ spanProcessors:[SqliteSpanProcessor], console:false })`,在 `startActiveSpan('turn')` 内既 `record` 一条决策记录(自动捕获 span_id)又结束 span;断言**同库**里 `decision_traces.span_id` === `otel_spans.span_id`,且 `getSpanById(traceId, spanId)` 能取回该 span(§8.1 同 ID 缝合闭环)
- [x] 5.4 采样策略测试:`initTelemetry` 不传 sampler → 默认全量(造多个 span 全部落 SQLite);传 `AlwaysOffSampler` → provider 不记录(`onEnd` 不被调用,SQLite 无 span),证明"OTel 侧采样可调而 SQLite processor 只落它收到的全量",并注释说明真相源全量须配 AlwaysOn
- [x] 5.5 `createSpanProcessorFromEnv`:默认关 → `enabled:false`;`CHAT_A_OTEL_SPAN_SQLITE=1` → `enabled:true` + dbPath 生效;批量 env 解析

## 6. 收尾与验证

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿(仅新增/可选入参,不级联其它包)
- [x] 6.2 worktree 根 `npx vitest run` 全绿(落库往返 + 投影 + 缝合 + 采样 + env + 既有用例不回归)
- [x] 6.3 自检与 canonical 一致:§8.1 同 trace_id/span_id 缝合 + 两侧分治采样(OTel 可采样 / SQLite 不采样全量)、§3.2 异步导出失败优雅降级 + 开关/批量/采样率外置无 magic number + 迁移零丢失;确认仅改 `packages/observability`、未越界
