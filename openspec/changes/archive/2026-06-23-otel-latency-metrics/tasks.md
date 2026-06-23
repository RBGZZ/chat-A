## 1. conventions:metric 名 + 维度键

- [x] 1.1 `conventions.ts`:新增 `METRIC`(`TURN_DURATION='chat_a.turn.duration'`、`LLM_DURATION='chat_a.llm.duration'`)
- [x] 1.2 `conventions.ts`:新增 `METRIC_ATTR`(provider/model/operation 复用 `GENAI.*`,emotion 私有低基数键);注释强调忌高基数

## 2. metrics 接缝(metrics.ts)

- [x] 2.1 `initMetrics(opts)`:装全局 `MeterProvider`,可注入 `readers`(in-memory 测试)+ 可选 console exporter(无 reader 时默认开);幂等;返回 `MetricsHandle`
- [x] 2.2 `MetricsHandle`:`shutdown()`(硬超时 + `metrics.disable()` 还原 no-op)+ `forceFlush()`(测试断言前 flush);异常自吞(§3.2)
- [x] 2.3 `getMeter()`:取 chat-A meter;未 init → API 默认 no-op
- [x] 2.4 `createTurnMetrics(meter?)` → `TurnMetrics`:turn/llm 两个 Histogram(unit='s');`recordTurn`/`recordLlm`
- [x] 2.5 record 降级:非法时长(负/NaN/Infinity)静默丢弃;record 裹 try/catch 不抛;维度按 `METRIC_ATTR` 映射(省略项不写,合 exactOptionalPropertyTypes)
- [x] 2.6 `index.ts` 导出 metrics;`package.json` 加 `@opentelemetry/sdk-metrics`

## 3. 测试(test/metrics.test.ts)

- [x] 3.1 in-memory reader:`recordTurn`/`recordLlm` → Histogram count/sum 正确,unit='s',维度键收敛
- [x] 3.2 不同维度组合各成一条 data point(标签隔离)
- [x] 3.3 非法时长静默丢弃(只有效样本入直方图)
- [x] 3.4 init 幂等
- [x] 3.5 降级:未 init record 不抛不产 metric;shutdown 后 record 不抛;无维度入参不抛

## 4. 验收

- [x] 4.1 worktree 根 `pnpm install`(加依赖)+ `pnpm -r typecheck` 全绿
- [x] 4.2 `npx vitest run` 全量全绿(含新增 metrics 用例)
- [x] 4.3 `openspec validate otel-latency-metrics --strict` 通过
