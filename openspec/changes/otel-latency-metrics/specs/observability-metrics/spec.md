## ADDED Requirements

### Requirement: metrics 初始化接缝

系统 SHALL 提供 `initMetrics(opts)`,装载一个全局 OTel `MeterProvider`(§8.1 指标侧)。它 SHALL 支持注入额外的 `MetricReader`(测试用 in-memory reader;未来 OTLP/Prometheus),并 MAY 在未注入 reader 时默认挂一个 console exporter(本地观察)。`initMetrics` MUST 幂等——重复调用返回指向同一 provider 的 handle,不重复注册。返回的 `MetricsHandle` SHALL 提供 `shutdown()`(带硬超时,树莓派上 flush 可能卡,§8.1)与 `forceFlush()`(主动收集导出,供测试断言前 flush);二者内部异常 MUST 自吞,绝不拖垮主流程(§3.2)。

#### Scenario: 注入 in-memory reader 后可断言记录

- **WHEN** 以 in-memory reader 调用 `initMetrics`,记录若干延迟样本并 `forceFlush`
- **THEN** 该 reader 的 exporter 能取回对应 Histogram 的累计 count/sum 与维度

#### Scenario: 重复 init 幂等

- **WHEN** 连续两次调用 `initMetrics`
- **THEN** 复用同一 provider,第二次的选项被忽略,两个 handle 均可正常 flush/shutdown 不抛

### Requirement: getMeter 与未初始化降级

系统 SHALL 提供 `getMeter()` 取 chat-A 的 meter。未调用 `initMetrics` 时,`getMeter()` MUST 返回 OTel API 默认的 **no-op meter**;经其建立的 Histogram 与 `record` MUST 零成本、不产生任何 metric、绝不抛出(优雅降级,§3.2)。`shutdown()` 后系统 MUST 将全局还原为 no-op,使其后的 `record` 仍不抛。

#### Scenario: 未 init 时 record 是 no-op

- **WHEN** 未调用 `initMetrics`,经 `getMeter()` 建立记录器并记录延迟
- **THEN** 调用不抛,且无 metric 被导出

#### Scenario: 关闭后 record 不崩

- **WHEN** `initMetrics` 后调用 `shutdown()`,再记录延迟
- **THEN** 全局已还原 no-op,record 不抛出

### Requirement: 回合延迟 Histogram 记录器

系统 SHALL 提供 `createTurnMetrics()` 返回 `TurnMetrics` 接缝,内部各持一个 OTel **Histogram**,记录回合级与 LLM 调用延迟(§8.1:延迟用 Histogram,仿 LiveKit `lk.agents.turn.*`)。它 SHALL 暴露 `recordTurn(durationSec, attrs?)` 与 `recordLlm(durationSec, attrs?)`,时长单位 MUST 为**秒**(Histogram `unit='s'`)。记录器 MUST 把弱类型业务维度(provider/model/operation/emotion)映射到收敛后的低基数维度键;省略的维度 MUST NOT 写入(合 exactOptionalPropertyTypes)。`record` MUST 对非法时长(负数/NaN/Infinity)静默丢弃,并 MUST NOT 向调用点抛出任何异常(§3.2)。调用点(runtime)与本接缝解耦——本能力 MUST NOT 自行接入回合编排调用点(§3.1,留串行接线)。

#### Scenario: 记录延迟样本进对应 Histogram

- **WHEN** 调用 `recordTurn`/`recordLlm` 记录若干秒级时长并带维度
- **THEN** 对应 metric(`chat_a.turn.duration` / `chat_a.llm.duration`)的 Histogram 累计样本数与和正确,单位为秒,维度键为收敛后的低基数键

#### Scenario: 不同维度组合标签隔离

- **WHEN** 以不同的 provider 维度各记录一条 turn 延迟
- **THEN** 同一 Histogram 产出两条独立 data point

#### Scenario: 非法时长被丢弃

- **WHEN** 记录负数 / NaN / Infinity 时长,以及一条有效时长
- **THEN** 只有有效样本进入直方图,调用全程不抛

### Requirement: metric 名与维度键单一命名

系统 SHALL 将所有延迟 metric 名与维度键收敛到 `conventions`(`METRIC`、`METRIC_ATTR`),杜绝调用点散落 magic string(§3.2 单一权威)。维度键 MUST 为低基数枚举,MUST NOT 含 correlation/session/turn id 等高基数标识(那属 trace 侧);provider/model/operation 维度键 SHALL 复用 GenAI 语义约定同名键,使 metric 与 trace 两侧标签可对齐。

#### Scenario: metric 名取自常量

- **WHEN** 记录器创建 turn/llm Histogram
- **THEN** 其 metric 名取自 `METRIC.TURN_DURATION` / `METRIC.LLM_DURATION`,维度键取自 `METRIC_ATTR`
