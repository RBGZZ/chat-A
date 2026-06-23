## Why

§8.1 明确:延迟用 **metric Histogram**(原话:"延迟用 metric Histogram,仿 LiveKit `lk.agents.turn.*`")。`packages/observability` 目前已有 OTel **追踪**骨架(`telemetry.ts` initTelemetry/getTracer)、属性约定(`conventions.ts` GENAI/CHAT_A)、SQLite 决策 trace(sink/reader/stats),但**指标侧(metrics)完全缺位**——没有任何记录回合级延迟分布的接缝。

本切片在 **observability 包内**补上 metrics 接缝(初始化 + 轻量记录器),与既有 trace 骨架同构、命名收敛到同一 conventions。**不接 runtime 调用点**(那是后续串行切片);先把接缝和降级行为做对、测好。

## What Changes

- **新增 metrics 初始化 `initMetrics()`**(对应 `initTelemetry`):装一个全局 `MeterProvider`,可选 console exporter(本地观察)或注入 in-memory reader(测试)。返回 `MetricsHandle`(`shutdown` 带硬超时 + `forceFlush`)。幂等。
- **新增 `getMeter()`**:取 chat-A meter;未 init 时返回 OTel API 默认 **no-op meter**(不污染、零成本)。
- **新增回合 metrics 记录器接缝 `createTurnMetrics()` → `TurnMetrics`**:`recordTurn(durationSec, attrs)` / `recordLlm(durationSec, attrs)`,内部各持一个 `Histogram`(`chat_a.turn.duration` / `chat_a.llm.duration`,单位秒)。维度(provider/model/operation/emotion)复用 conventions,低基数。
- **扩 `conventions.ts`**:新增 `METRIC`(metric 名常量)+ `METRIC_ATTR`(维度键,provider/model/operation 复用 GENAI 同名键)。单一命名,无 magic string。
- **降级**:metrics 关闭/未初始化/已 shutdown 时 `record` 是 no-op,绝不抛;非法时长(负数/NaN/Infinity)静默丢弃。

Non-goals(本切片不做):

- **不接 runtime 调用点**(conversation.ts 等)——留后续串行切片接线,锚定语音真实时刻。
- 不做 OTLP/Prometheus exporter 接线(预留 `readers` 注入口即可)。
- 不做成本 metric(§3.2 待细化的"每回合成本")——本切片只延迟。
- 不动 trace 骨架 / 决策 trace 既有行为。

## Capabilities

### New Capabilities
- `observability-metrics`: OTel 延迟 metrics 接缝——initMetrics/getMeter(no-op 降级)、回合延迟 Histogram 记录器(turn/llm duration,秒)、metric 名与维度键收敛到 conventions、未初始化/关闭/非法值全部安全降级。

## Impact

- **延迟预算(§3.2)**:metrics record 是内存级 Histogram 累加,无网络无 I/O;未 init 时是 no-op。对回合无可感知延迟。**本切片不接调用点**,运行时零影响。
- 代码(仅 `packages/observability/**`):
  - `src/metrics.ts`(新):`initMetrics`/`getMeter`/`createTurnMetrics` + `MetricsHandle`/`TurnMetrics` 类型。
  - `src/conventions.ts`:加 `METRIC` + `METRIC_ATTR`。
  - `src/index.ts`:导出 metrics。
  - `package.json`:加 `@opentelemetry/sdk-metrics`(^2.8.0,与既有 sdk-trace 同档)。
  - `test/metrics.test.ts`(新):in-memory reader 断言 Histogram 记录值 + 维度;no-op/关闭/非法值降级。
- 数据:无 schema 变更。
- 已锁决策:遵循 §8.1(Histogram 仿 LiveKit)、§3.2(优雅降级、行为即配置、单一权威命名)、接缝哲学(调用点解耦)。
- **冲突风险**:仅新增 observability 内依赖 `@opentelemetry/sdk-metrics`(其它包不碰);不改任何其它包。
