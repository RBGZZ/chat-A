## ADDED Requirements

### Requirement: 决策 trace 只读统计聚合

系统 SHALL 提供只读 `DecisionTraceStats`,以**只读**方式打开决策 trace 库(默认 `chat-a-trace.db`,路径由配置驱动),只经 `SELECT` 聚合产出跨回合统计:`emotion` / `posture` / `provider` 的**计数分布**;`latency_ms` 的**均值**与**分位 p50/p95**;**按 `sessionId` 的回合计数**与**总回合数**;**recall 命中统计**(`recalled` JSON 数组长度的均值、有召回占比)。`DecisionTraceStats` MUST 纯只读——MUST NOT 改写、建表、迁移,亦 MUST NOT 触碰 `SqliteDecisionTraceSink` 的写路径与契约或 `DecisionTraceReader` 的现有契约(单向:库 → stats)。

#### Scenario: 计数分布聚合

- **WHEN** 库内已有若干回合且请求统计
- **THEN** 返回 emotion / posture / provider 各取值到其回合计数的分布

#### Scenario: 延迟均值与分位

- **WHEN** 库内已有若干回合且请求统计
- **THEN** 返回 `latency_ms` 的均值与 p50 / p95 分位,分位按确定性算法(nearest-rank)计算

#### Scenario: 会话回合计数与总数

- **WHEN** 请求统计
- **THEN** 返回每个 `sessionId` 的回合计数与全库总回合数

#### Scenario: recall 命中统计

- **WHEN** 请求统计
- **THEN** 返回 `recalled` 数组长度的均值与"有召回(长度大于 0)"回合的占比

### Requirement: 只读统计的优雅降级

`DecisionTraceStats` 在库文件不存在、表缺失或库损坏时 MUST 优雅降级:返回**空统计对象**(总回合数为 0、各分布为空、延迟与 recall 指标为 0),并经告警回调记录(默认 `console.warn`),MUST NOT 抛出以致崩溃。分位计算在样本为空(n=0)或单样本(n=1)时 MUST 返回确定且不崩的结果。

#### Scenario: 库不存在返回空统计

- **WHEN** 指向一个不存在的库文件并请求统计
- **THEN** 返回空统计对象且不抛错,经告警回调记录一次

#### Scenario: 损坏库返回空统计

- **WHEN** 指向一个损坏的库文件并请求统计
- **THEN** 返回空统计对象且不抛错,经告警回调记录

#### Scenario: 分位边界不崩

- **WHEN** 样本数为 0 或 1
- **THEN** 分位计算返回确定结果(0 或该唯一值)而不抛错

### Requirement: 决策 trace 统计查看子命令

决策 trace 查看 CLI SHALL 提供 `stats` 子命令,把统计聚合(总回合数、emotion / posture / provider 分布、延迟均值与分位、recall 命中、各会话回合数)以中文漂亮打印。库路径 MUST 由配置驱动(命令行参数 / 环境变量 / 默认值),该子命令 MUST NOT 修改 `packages/client` 或写入 trace 库,且 MUST NOT 改变既有 `list` / `show` 子命令的行为。

#### Scenario: 漂亮打印统计

- **WHEN** 运行 `stats` 子命令且库内有数据
- **THEN** 中文分块打印总回合数、各分布(按计数倒序)、延迟均值与 p50/p95、recall 命中与各会话回合数

#### Scenario: 空库或库不存在时不崩

- **WHEN** 指向空库或不存在的库运行 `stats`
- **THEN** 打印友好"(无数据)"提示而非崩栈,进程正常退出
