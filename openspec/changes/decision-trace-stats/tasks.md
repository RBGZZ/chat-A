## 1. 只读统计聚合接缝（observability）

- [x] 1.1 `observability/src/decision-trace-stats.ts`:`DecisionTraceStats` 类,构造期以 `node:sqlite` `DatabaseSync(path, { readOnly: true })` 容错打开(失败/不存在 → 标记降级 + 告警,不抛);`onWarn?(err, op)` 回调,默认 `console.warn`(复刻 reader 降级语义,不复用 reader 实例)
- [x] 1.2 计数分布:`emotionCounts`/`postureCounts`/`providerCounts`(GROUP BY,各取值 → 计数;posture 排除 NULL)
- [x] 1.3 延迟:`latency.count`/`mean`(SQL AVG)+ `p50`/`p95`(取全部 latency_ms 在 JS 侧 nearest-rank 算分位,边界 n=0/1 安全)
- [x] 1.4 session 回合计数 `sessionTurnCounts`(GROUP BY session_id)+ 总回合数 `totalTurns`(COUNT(*))
- [x] 1.5 recall 命中:取 `recalled` 在 JS 侧 `JSON.parse` 算数组长度(解析失败按 0 容错),产 `meanRecalledLen` 与 `recalledRatio`(长度>0 占比)
- [x] 1.6 降级:表缺失/损坏/库不存在 → 返回全空统计对象(totalTurns=0、空 Record、latency 全 0、recall 全 0),经 onWarn 告警,不抛
- [x] 1.7 `close()` 释放只读句柄;`observability/src/index.ts` 导出 `DecisionTraceStats` 及结果类型(不改 reader/sink 导出)

## 2. CLI stats 子命令（observability bin，可选）

- [x] 2.1 `observability/src/bin/trace.ts` 加 `stats [--db <path>]`:沿用现有库路径优先级,中文分块打印总回合数 / emotion·posture·provider 分布(按计数倒序)/ 延迟 mean·p50·p95 / recall 均值长度·有召回占比 / 各 session 回合数(倒序、top-N)
- [x] 2.2 帮助文案补 `stats`;库不存在/空库 → 友好"(无数据)"提示,不崩;**不改 list/show 现有行为**

## 3. 测试

- [x] 3.1 写入若干 trace(用 `SqliteDecisionTraceSink`)后聚合正确:emotion/posture/provider 计数、totalTurns、sessionTurnCounts 与预期一致
- [x] 3.2 latency 均值 + 分位:构造已知 latency 集,断言 mean/p50/p95(含 nearest-rank 边界:n=1、偶数/奇数样本)
- [x] 3.3 recall 命中:混合有/无召回的回合,断言 meanRecalledLen 与 recalledRatio
- [x] 3.4 posture 分布排除无姿态回合;有姿态回合按取值计数
- [x] 3.5 空库/不存在库/损坏库降级:返回全空统计对象、不抛、告警被调用
- [x] 3.6 分位边界单测:n=0 返回 0;n=1 p50=p95=唯一值

## 4. 收尾

- [x] 4.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 4.2 `npx vitest run` 全绿
