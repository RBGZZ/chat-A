## Context

§8.1 要求决策 trace 是**单一真相源、无条件全量、可重放**。decision-trace-sqlite 让 `SqliteDecisionTraceSink` 无损落库(schema v2),decision-trace-viewer 加了只读 `DecisionTraceReader` + `bin/trace.ts`(单回合查看)。但 reader 面向"逐条/单回合",**没有跨回合聚合**:开发期想看情绪/姿态/provider 分布、回合延迟分位、各 session 回合数、recall 命中率,只能手写 SQL。本切片在 observability 包内补**只读统计聚合**,与 sink/reader 解耦、互不影响。

可复用:schema v2 列定义与 `asNumber`(bigint→number)手法、`node:sqlite` `readOnly: true` 容错打开 + 降级语义(复刻 reader 的 `#onWarn`/lazy 打开)、`DecisionTraceRecalled` 类型。

约束:接缝边界(stats 只读、单向,不依赖也不改 sink/reader)、优雅降级(库不存在/损坏返回空统计 + 告警不崩)、行为即配置(库路径走参数/环境变量)、数据迁移纪律(stats 不建表/不迁移,只读既有 schema)、exactOptionalPropertyTypes。**硬约束:只改 `packages/observability/**`,不动其它包;不改 sink 写路径、不改 reader 现有契约。**

## Goals / Non-Goals

**Goals:**
- 只读 `DecisionTraceStats`:emotion/posture/provider 计数分布、latency_ms 均值 + p50/p95、按 session 回合计数 + 总回合数、recall 命中(avg 长度 + 有召回占比)。
- 库不存在/损坏优雅降级,返回空统计对象 + 告警,绝不崩。
- 可选 `stats` CLI 子命令,中文漂亮打印聚合。
- 不改写路径、不动 sink/reader 契约。

**Non-Goals:**
- 时间窗/任意 group by 查询;写/删/改 trace;client/runtime 接线;图表/Web/TUI。

## Decisions

### D1:stats 独立只读打开,与 sink/reader 解耦

`DecisionTraceStats` 自己用 `new DatabaseSync(path, { readOnly: true })` 打开同库(复刻 reader 的容错打开 + `#onWarn` 降级),**不建表、不迁移、不写**,也**不复用** reader 实例或其私有句柄。理由:① reader 现有契约一字不改(只新增姊妹只读模块);② stats 的查询是聚合 SELECT,与 reader 的逐行投影关注点不同,各自独立句柄更内聚、爆炸半径更小;③ CLI 多在另一个进程跑,共享句柄无意义。**备选**:给 reader 加 `stats()` 方法——会改 reader 现有契约(被严格约束禁止)且把聚合关注点塞进逐行 reader,弃。

### D2:聚合在 SQL 侧算,分位在 JS 侧算

- 计数分布:`SELECT emotion, COUNT(*) ... GROUP BY emotion`(posture/provider 同),posture 可空,NULL 行归入"(无)"桶或直接排除——选**排除 NULL**(姿态分布只统计有姿态的回合,更贴近"负面姿态出现频率"语义;总回合数另给,可推无姿态占比)。
- latency 均值:`SELECT AVG(latency_ms), COUNT(*) FROM ...`。
- 分位 p50/p95:`node:sqlite` 无内置分位函数,**在 JS 侧算**——`SELECT latency_ms ... ORDER BY latency_ms ASC` 取全部值,用"最近秩"法(nearest-rank)取分位:`idx = ceil(p/100 * n) - 1`(clamp 到 `[0, n-1]`)。值集为开发期单库,量级可控;若日后量级巨大可改 SQL 窗口函数,本期从简。
- session 回合计数:`GROUP BY session_id`;总回合数:`COUNT(*)`。
- recall:`recalled` 是 JSON 数组文本,**无法用纯 SQL 可靠算长度**(避免依赖 `json_array_length` 的可用性/容错),改为 `SELECT recalled FROM ...` 取出在 JS 侧 `JSON.parse` 算数组长度(解析失败按长度 0 容错):均值 = 总长度/回合数,有召回占比 = (长度>0 的回合数)/回合数。

### D3:分位计算边界

- n=0(空库/无数据):均值与所有分位返回 `0`(或约定的空值),`count=0`;调用方据 `totalTurns=0` 判断"无数据"。
- n=1:p50=p95=该唯一值。
- nearest-rank:`rank = ceil(p/100 * n)`,`idx = clamp(rank - 1, 0, n - 1)`。p50 of [10,20,30,40] → rank=2 → idx=1 → 20;p95 → rank=4 → idx=3 → 40。确定性,写 golden 断言。

### D4:返回形状(空统计对象)

`DecisionTraceStatsResult`:
- `totalTurns: number`
- `emotionCounts: Record<string, number>` / `postureCounts` / `providerCounts`
- `latency: { count; mean; p50; p95 }`
- `sessionTurnCounts: Record<string, number>`
- `recall: { meanRecalledLen; recalledRatio }`(ratio ∈ [0,1])

降级/空库时返回**全空**对象:`totalTurns=0`、空 Record、`latency` 全 0、`recall` 全 0。调用方与 CLI 据此打印"(无数据)"。

### D5:CLI `stats` 子命令(可选,本切片做)

`bin/trace.ts` 加 `stats [--db <path>]`:中文分块打印——总回合数、emotion/posture/provider 分布(取值 + 计数,按计数倒序)、延迟(mean/p50/p95)、recall(均值长度 + 有召回占比 %)、各 session 回合数(倒序、可截断 top N)。库路径优先级沿用现有 `--db > CHAT_A_DECISION_TRACE_DB > 默认`。**不改 list/show 现有行为**,仅新增分支与帮助文案。

## Risks / Trade-offs

- **分位精度**:nearest-rank 与连续插值法在小样本上略有差异——开发期诊断够用,且确定性可测;若需精确插值另开。
- **全量取 latency/recalled 到 JS**:大库下内存占用上升。本期为开发期单库,量级可控;留作后续优化(可改 SQL 端流式/窗口函数)点。
- **schema 漂移**:stats 读固定 v2 列;sink 升级 schema 时 stats 同包同 PR 演进。缺列由降级捕获。

## Migration Plan

无数据迁移:stats 纯只读既有库;无 schema 变更;无跨包接线。新增文件 + index 导出 + bin 子命令,向后兼容。

## Open Questions

- 是否需要 `--json` 原始输出供下游脚本消费?本期先人读漂亮打印,留作后续增量。
- session 回合数是否需 top-N 截断阈值化(行为即配置)?本期 CLI 侧给个默认 top 上限,留作后续旋钮。
