import { describe, it, expect, afterEach } from 'vitest';
import {
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  AggregationTemporality,
  DataPointType,
  type ResourceMetrics,
  type HistogramMetricData,
} from '@opentelemetry/sdk-metrics';
import {
  initMetrics,
  getMeter,
  createTurnMetrics,
  METRIC,
  METRIC_ATTR,
  type MetricsHandle,
} from '../src/index';

// 每个用例自带 handle,afterEach 关掉以还原全局为 no-op(隔离,避免用例间串状态)。
let handle: MetricsHandle | undefined;
afterEach(async () => {
  if (handle !== undefined) {
    await handle.shutdown();
    handle = undefined;
  }
});

/** 建一个 in-memory exporter + reader,返回 [reader, exporter] 供注入 + 断言。 */
function inMemory(): { reader: PeriodicExportingMetricReader; exporter: InMemoryMetricExporter } {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  // 导出周期拉很长:测试里只靠 forceFlush 主动收集,不靠定时器。
  const reader = new PeriodicExportingMetricReader({ exporter, exportIntervalMillis: 600_000 });
  return { reader, exporter };
}

/** 从导出的 ResourceMetrics 里找指定名字的 Histogram metric(可能不存在 → undefined)。 */
function findHistogram(all: ResourceMetrics[], name: string): HistogramMetricData | undefined {
  for (const rm of all) {
    for (const scope of rm.scopeMetrics) {
      for (const m of scope.metrics) {
        if (m.descriptor.name === name && m.dataPointType === DataPointType.HISTOGRAM) {
          return m;
        }
      }
    }
  }
  return undefined;
}

describe('initMetrics + createTurnMetrics(Histogram 记录)', () => {
  it('recordTurn/recordLlm 把值记进对应 Histogram,带收敛后的维度键', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });

    const tm = createTurnMetrics(getMeter());
    tm.recordTurn(1.5, { provider: 'deepseek', model: 'deepseek-chat', emotion: 'content' });
    tm.recordTurn(0.5, { provider: 'deepseek', model: 'deepseek-chat', emotion: 'content' });
    tm.recordLlm(0.8, { provider: 'deepseek', model: 'deepseek-chat', operation: 'chat' });

    await handle.forceFlush();
    const all = exporter.getMetrics();

    const turn = findHistogram(all, METRIC.TURN_DURATION);
    expect(turn).toBeDefined();
    expect(turn?.descriptor.unit).toBe('s');
    // 两条 turn 样本累计:count=2, sum=2.0。
    const turnDp = turn?.dataPoints[0];
    expect(turnDp?.value.count).toBe(2);
    expect(turnDp?.value.sum).toBeCloseTo(2.0, 6);
    // 维度键收敛到 conventions(provider/model/emotion)。
    expect(turnDp?.attributes[METRIC_ATTR.PROVIDER]).toBe('deepseek');
    expect(turnDp?.attributes[METRIC_ATTR.MODEL]).toBe('deepseek-chat');
    expect(turnDp?.attributes[METRIC_ATTR.EMOTION]).toBe('content');

    const llm = findHistogram(all, METRIC.LLM_DURATION);
    expect(llm).toBeDefined();
    const llmDp = llm?.dataPoints[0];
    expect(llmDp?.value.count).toBe(1);
    expect(llmDp?.value.sum).toBeCloseTo(0.8, 6);
    expect(llmDp?.attributes[METRIC_ATTR.OPERATION]).toBe('chat');
  });

  it('不同维度组合各成一条 data point(标签隔离)', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const tm = createTurnMetrics(getMeter());
    tm.recordTurn(1.0, { provider: 'deepseek' });
    tm.recordTurn(2.0, { provider: 'anthropic' });
    await handle.forceFlush();

    const turn = findHistogram(exporter.getMetrics(), METRIC.TURN_DURATION);
    expect(turn?.dataPoints.length).toBe(2);
  });

  it('非法时长(负数 / NaN / Infinity)静默丢弃,不进直方图', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const tm = createTurnMetrics(getMeter());
    tm.recordTurn(-1, { provider: 'x' });
    tm.recordTurn(Number.NaN, { provider: 'x' });
    tm.recordTurn(Number.POSITIVE_INFINITY, { provider: 'x' });
    tm.recordTurn(0.7, { provider: 'x' }); // 唯一有效样本
    await handle.forceFlush();

    const turn = findHistogram(exporter.getMetrics(), METRIC.TURN_DURATION);
    expect(turn?.dataPoints[0]?.value.count).toBe(1);
    expect(turn?.dataPoints[0]?.value.sum).toBeCloseTo(0.7, 6);
  });

  it('init 幂等:重复调用复用同一 provider', async () => {
    const { reader } = inMemory();
    const h1 = initMetrics({ readers: [reader], console: false });
    const h2 = initMetrics({ console: true }); // 第二次选项被忽略(已 active)
    handle = h1;
    // 两个 handle 都能 flush/shutdown 不抛(指向同一 provider)。
    await expect(h2.forceFlush()).resolves.toBeUndefined();
  });
});

describe('降级:未初始化 / 关闭后 record 是 no-op,不崩', () => {
  it('未 init 时 getMeter 是 no-op,record 不抛、不产生 metric', () => {
    // 不调用 initMetrics:全局是 API 默认 no-op meter。
    const tm = createTurnMetrics(getMeter());
    expect(() => {
      tm.recordTurn(1.2, { provider: 'deepseek' });
      tm.recordLlm(0.4, { provider: 'deepseek', operation: 'chat' });
    }).not.toThrow();
  });

  it('shutdown 后再 record 不抛(全局已还原 no-op)', async () => {
    const { reader } = inMemory();
    const h = initMetrics({ readers: [reader], console: false });
    const tm = createTurnMetrics(getMeter());
    await h.shutdown(); // 还原全局 no-op
    expect(() => tm.recordTurn(1.0, { provider: 'x' })).not.toThrow();
    // handle 已手动关,afterEach 不再处理。
    handle = undefined;
  });

  it('无维度入参时 record 也不抛', () => {
    const tm = createTurnMetrics(getMeter());
    expect(() => tm.recordTurn(0.3)).not.toThrow();
  });
});
