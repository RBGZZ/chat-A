## Why

canonical §8.1 把"每个行为可被完整重建"列为**开发期硬要求**,决策 trace 是**单一真相源、无条件全量、可重放**。我们已让 `SqliteDecisionTraceSink` 无损落库(decision-trace-sqlite),并补了**只读单回合查看**(decision-trace-viewer:`DecisionTraceReader` + `bin/trace.ts`)。但库里积累的成千上万回合**只能逐条看**——无法一眼回答"这段时间她的情绪/姿态分布如何""哪个 provider/model 用得最多""回合延迟 p95 是多少""召回到底命中没有"。开发期调参、定位回归、验收降级,都需要**跨回合的聚合视图**。本切片补上**只读指标/统计聚合**,把已落的真相源变成可量化的可观测面。

## What Changes

- **新增只读 `DecisionTraceStats`**(observability):读同一库,**只 SELECT 聚合**,产出:
  - emotion / posture / provider 的**计数分布**(各取值 → 计数)。
  - `latency_ms` 的**均值 + 分位**(p50/p95)。
  - **按 session 的回合计数** + **总回合数**。
  - **recall 命中统计**:`recalled` JSON 数组长度的均值、有召回(长度 > 0)的占比。
  - 库不存在 / 表缺失 / 损坏 → **优雅降级**(返回空统计对象 + 告警,绝不崩)。
- **可选:`bin/trace.ts` 加 `stats` 子命令**,把上述聚合中文漂亮打印。
- **纯只读、不改写路径**:不动 `SqliteDecisionTraceSink` 写契约,不改 `DecisionTraceReader` 现有契约;只**新增** stats 模块 + index 导出 + 可选 bin 子命令。

Non-goals(本切片不做):

- **时间窗/分组查询 DSL**(按天/按小时 rollup、任意 group by):本期为固定几组聚合,复杂查询另开。
- **写/删/改 trace**:stats 纯只读;sink 与 reader 契约一字不改。
- **跨包接线**(client/runtime):只在 observability 内提供库与可选 bin 子命令,不动 client/cli.ts。
- **图表/Web/TUI 可视化**:本期为命令行漂亮打印,GUI 留待后续。

## Capabilities

### New Capabilities
<!-- 纯增量:在既有 decision-trace 能力上加"只读统计聚合" -->

### Modified Capabilities
- `decision-trace`: 新增**只读统计聚合 `DecisionTraceStats`**(计数分布 / 延迟分位 / session 回合计数 / recall 命中)与**可选 `stats` CLI 子命令**——在既有"无条件全量落库 + 单回合查看"之上补齐"跨回合聚合视图",库不存在/损坏优雅降级;不改写路径、不动 sink/reader 契约。

## Impact

- **延迟预算(§3.2)**:stats 与 CLI 为**离线/带外**工具,不在回合热路径,对首字/回合延迟零影响。
- 代码:
  - `@chat-a/observability`:新增 `decision-trace-stats.ts`(`DecisionTraceStats` + 只读打开 + 聚合 SELECT + 分位计算 + 降级),`index.ts` 导出 stats 及其类型;`src/bin/trace.ts` 加 `stats` 子命令(可选)。
- 数据:**纯只读**同库,不动 schema、不动记忆库;库不存在/损坏只返回空统计 + 告警。
- 已锁决策:接缝边界(只读单向、与 sink/reader 解耦)、优雅降级、行为即配置(库路径走参数/环境变量)均遵循;**不改其它任何包**(client/runtime/memory/persona/cognition/providers 零改动)。
