## Context

§8.1 指标侧只有一句硬要求:"延迟用 metric Histogram(仿 LiveKit `lk.agents.turn.*`)"。trace 侧已落地(`telemetry.ts` initTelemetry/getTracer、`conventions.ts` GENAI/CHAT_A、SQLite 决策 trace),metrics 侧空白。可复用的同构先例:

- **telemetry.ts 模式**:`initX(opts)` 装全局 provider(可注入 processor/reader、可选 console),返回带硬超时 `shutdown` 的 handle;`getX()` 未 init 时取 API 默认 no-op。metrics 直接套同一形状。
- **conventions.ts 单一命名**:trace 属性键集中一处、锁版本。metric 名/维度键同样收口于此。
- **接缝哲学(§3.1)**:调用点(runtime)与可观测性实现解耦——本切片只产接缝,**不接调用点**。

约束:延迟预算(record 内存级、no-op 降级)、优雅降级(未 init/关闭/非法值不崩)、行为即配置(metric 名/维度/单位外置,无 magic number)、爆炸半径(仅动 observability 包)。

## Goals / Non-Goals

**Goals:**
- metrics 初始化接缝 `initMetrics`,可注入 in-memory reader(测试)/ console(本地),幂等 + 硬超时 shutdown + forceFlush。
- `getMeter()` no-op 降级(未 init 零成本)。
- 回合延迟记录器 `createTurnMetrics`:turn/llm 两个 Histogram(秒),低基数维度。
- metric 名 + 维度键收敛到 conventions。

**Non-Goals:**
- 接 runtime 调用点(串行后续);OTLP/Prometheus exporter;成本 metric;改 trace/决策 trace。

## Decisions

### D1:与 telemetry.ts 同构,而非塞进同一 init

metrics 与 trace 是 OTel 里**两条独立管线**(MeterProvider vs TracerProvider、reader vs spanProcessor、生命周期/导出节奏不同)。强行合并 init 会耦合两套选项、模糊降级边界。故 **`initMetrics` 独立**、与 `initTelemetry` 形状对称(opts: serviceName/console/readers/超时;handle: shutdown/forceFlush)。**备选**:合并成一个 initObservability——耦合度高、违反单一职责,弃。

### D2:记录器接缝 `TurnMetrics`,调用点只见 record

```ts
interface TurnMetrics {
  recordTurn(durationSec: number, attrs?: TurnMetricAttributes): void;
  recordLlm(durationSec: number, attrs?: TurnMetricAttributes): void;
}
function createTurnMetrics(meter?: Meter): TurnMetrics;
```
把"记哪些 Histogram、带哪些维度、单位是什么"收口到一个对象;后续 runtime 接线时只调 `recordTurn/recordLlm`,不直接碰 OTel `meter.createHistogram`。`attrs` 是弱类型业务字段(provider/model/operation/emotion),内部映射到收敛的维度键。**备选**:直接暴露 meter 让调用点自建 Histogram——名字/单位会在调用点散落漂移,违背单一命名,弃。

### D3:单位统一秒(s)

OTel/Prometheus 直方图惯例用秒(`http.server.duration` 等)。`record` 入参即秒,Histogram `unit: 's'`。调用点拿到的是 ms 时自行 `/1000`(留给串行切片)。**理由**:跨工具(Grafana/Prometheus)分位聚合时单位一致,免换算歧义。

### D4:维度低基数,复用 GENAI 键

metric 标签**忌高基数**(每个唯一组合一条时序,基数爆炸拖垮后端)。故 `METRIC_ATTR` 只含 provider/model/operation/emotion 这类低基数枚举,**绝不**含 correlation/session/turn id(那是 trace 的活)。provider/model/operation 直接复用 `GENAI.*` 同名键值,保证 metric 与 trace 两侧标签可对齐 join。

### D5:三重降级

1. **未 init**:`getMeter()` 取 API 默认 no-op meter,`createHistogram`/`record` 静默零成本。
2. **已 shutdown**:`shutdown` 里 `metrics.disable()` 还原全局 no-op;之后 record 不崩。
3. **非法时长**:`!Number.isFinite(d) || d < 0` 静默丢弃(不污染分位),`record` 再裹 try/catch 兜底。
record 任何路径**绝不抛到调用点**(§3.2)。

### D6:惰性 vs 显式 meter

`createTurnMetrics(meter = getMeter())`:默认绑当前全局 meter(随 init 状态变化),也允许显式传 meter(测试隔离/多 provider)。Histogram 在 `createTurnMetrics` 时建一次——故应在 `initMetrics` 之后调用以落到真 reader;init 前调用则建在 no-op 上(record 静默,符合降级预期)。

## Risks / Trade-offs

- **新增依赖** `@opentelemetry/sdk-metrics`:仅 observability 包,版本对齐既有 `@opentelemetry/sdk-trace-*` ^2.8.0,API 1.9.1 已含 metrics API。风险低。
- **createTurnMetrics 须 init 后调**:若调用点在 init 前建记录器会绑 no-op。串行接线切片需注意调用顺序(本切片接缝文档已注明)。

## Migration Plan

无数据迁移。后续串行切片接 runtime 调用点(`Conversation` 回合收尾 record turn/llm duration,锚定语音真实时刻),并在 client 启动期 `initMetrics`(env 门控 console/exporter)。
