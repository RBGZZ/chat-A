## Why

设计 §8.1「两层追踪,同 ID 缝合」给出两条互补链路:**OTel trace**(实时/可采样/运维侧)与 **SQLite 决策 trace**(持久/不采样/单一真相源/可重放),二者用**同 trace_id/span_id** 缝合——运维侧在 OTel 发现一个慢回合,凭 trace_id/span_id 跳到 SQLite 取该回合的完整决策链。当前 `packages/observability` 已把决策 trace(回合级、由编排层在收尾组装)落 SQLite,也能从活动 OTel span 自动捕获 trace_id/span_id 缝合;但 **OTel span 自身从未落地到 SQLite**——`telemetry.ts` 只挂了 ConsoleSpanExporter / 测试用 InMemory processor,span 树(session→turn→{stt,llm,tts,classify,autonomy})结束后只在控制台一闪而过,无法持久回放、无法与决策记录在同一库里按 span_id 对照"这个慢回合的 stt/llm/tts 各占多久"。设计 §8.1/§11 把"**自写 SpanProcessor/Exporter 实现 + 采样策略**"明确标为待决项。

本 change 实现一个**自定义 SpanProcessor/Exporter**:把每个**结束的 span(onEnd)异步落到 SQLite 的 `otel_spans` 表**,字段含 trace_id/span_id/parent_span_id/name/start/end(锚定语音真实时刻)/duration/status 与 GenAI 语义约定属性(operation.name/provider/model/tokens/output.type/conversation.id)。span 用与现有决策记录**同一套 trace_id/span_id**,故二者天然在同一 SQLite 库里可缝合(决策记录的 `span_id` ←→ `otel_spans.span_id`)。

## What Changes

- **新增 `SqliteSpanSink`(`sqlite-span-trace.ts`)**:node:sqlite 持有 `otel_spans` 表,沿用现有 `SqliteDecisionTraceSink` 的版本化迁移手法(`span_meta` KV + 顺序 `MIGRATIONS` + 单事务回滚)。`recordSpan(span)` 把一条 `SpanRecord` upsert 落库(同 trace_id+span_id 幂等),内部失败自吞降级(§3.2)。新增只读还原能力供测试与 CLI 缝合查询。
- **新增 `SqliteSpanProcessor` + `SqliteSpanExporter`(`sqlite-span-processor.ts`)**:实现 OTel `SpanProcessor`,`onEnd(span)` 把 `ReadableSpan` 投影成 `SpanRecord`(读 spanContext / parentSpanContext / startTime / endTime / duration(HrTime→ms)/ status / attributes 的 GenAI 键)交给 sink。导出**异步**(microtask 队列 + 批量),`shutdown/forceFlush` 排空;导出失败只记日志、绝不抛回 SDK 主流程(§3.2)。Exporter 单独可用(实现 `SpanExporter.export/shutdown`),processor 默认包一个 `SimpleSpanProcessor` 同构的"逐条 onEnd → 批量写"。
- **采样策略(两侧分治)**:OTel 侧可采样(transport/console 噪声可控),**SQLite 侧不采样**(决策真相源,全量落)。做法:`telemetry.ts` 的 `initTelemetry` 增 `sampler?`(默认 `AlwaysOnSampler`,保证 SQLite 拿到全量 span);OTel 侧若要降噪,在**导出链路**而非 provider sampler 上采样——`SqliteSpanProcessor` 永远全量写 SQLite。采样率/批量阈值/开关全部外置(`CHAT_A_OTEL_SPAN_SQLITE`、`CHAT_A_OTEL_SPAN_SQLITE_DB`、批量大小),给合理默认,无 magic number(§3.2 行为即配置)。
- **装配入口**:新增 `createSpanProcessorFromEnv(env)`,默认关(返回"未启用"占位,零成本);开启后产出可直接塞进 `initTelemetry({ spanProcessors })` 的 `SqliteSpanProcessor`。与现有 `createDecisionTraceSinkFromEnv` 同构。
- **CLI 缝合**:`chat-a-trace show <id>` 在打印决策记录后,若该回合带 span_id,补打印同库 `otel_spans` 里挂在同 trace_id 下的 span 树阶段耗时(stt/llm/tts/...),实现"决策记录 ←→ span 阶段耗时"对照(纯只读,降级不崩)。

非破坏性:全部是**新增文件 + 新增可选入参/可选导出**;`initTelemetry` 不传 `sampler` 行为不变(默认 AlwaysOn,与此前 SDK 默认 ParentBased(AlwaysOn) 等价于"全采")。决策 trace 表、reader、stats 不动。

## Capabilities

### New Capabilities
<!-- 无(归入既有 observability-metrics 能力的增量) -->

### Modified Capabilities
- `observability-metrics`: 增"OTel span 落 SQLite"一组要求——自定义 `SpanProcessor`/`SpanExporter` 在 span `onEnd` 时把 span 投影落 `otel_spans` 表(字段 + GenAI 属性 + 锚定真实时刻),与现有 SQLite 决策记录用同 trace_id/span_id 缝合;两侧分治采样(OTel 可采样、SQLite 不采样全量落);导出异步且失败优雅降级;开关/批量/采样率外置配置。

## Impact

- **影响 canonical 章节**:§8.1(两层追踪同 ID 缝合的"OTel→SQLite 落地"一半 + 采样策略)、§11(此前标注的待决项"自写 SpanProcessor/Exporter + 采样策略")、§3.2(优雅降级 + 行为即配置 + 数据迁移纪律)。与权威设计一致,无冲突。
- **代码**:**仅 `packages/observability`**——新增 `sqlite-span-trace.ts`(SpanRecord 类型 + 落库 sink + 只读还原)、`sqlite-span-processor.ts`(SpanProcessor/Exporter + env 装配)、`telemetry.ts`(增可选 `sampler` 入参)、`index.ts`(导出新模块)、`bin/trace.ts`(show 缝合 span 阶段耗时)。不碰其它任何包。
- **延迟预算**:span 落库**完全在主流程之外**——onEnd 是 SDK 在 span 结束后的回调,写库走异步队列;不在语音首字/回合热路径上,不增首字延迟(§3.2)。导出失败/库锁不回灌主流程。
- **数据迁移**:新增 `otel_spans` 表 + 独立 `span_meta` 版本号,首次启用即建表;沿用顺序迁移 + 幂等 + 单事务回滚,零数据丢失(§3.2)。可与决策 trace 同库共存(同库不同表),也可独立库。
- **不涉及**:runtime 调用点接线(留串行,本切片只产接缝)、OTLP/远端导出、metrics 侧、向量/记忆/语音管线。
