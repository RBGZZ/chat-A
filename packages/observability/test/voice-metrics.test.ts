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
  createVoiceMetrics,
  withBudget,
  METRIC,
  METRIC_ATTR,
  STAGE,
  type BudgetWarning,
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

/** 在阶段 Histogram 里按 `chat_a.stage` 取值找对应 data point。 */
function stagePoint(hist: HistogramMetricData | undefined, stage: string) {
  return hist?.dataPoints.find((dp) => dp.attributes[METRIC_ATTR.STAGE] === stage);
}

describe('createVoiceMetrics:各阶段 Histogram 记录(§8.1 仿 lk.agents.turn.*)', () => {
  it('recordStageLatency 按阶段记入单一 STAGE_DURATION Histogram(ms→s,带 stage 维度)', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });

    const vm = createVoiceMetrics(getMeter());
    // 各阶段一条样本(入参毫秒)。
    vm.recordStageLatency(STAGE.TURN, 1500, { provider: 'deepseek', model: 'deepseek-chat' });
    vm.recordStageLatency(STAGE.TTFT, 300, { provider: 'deepseek' });
    vm.recordStageLatency(STAGE.TTFA, 800);
    vm.recordStageLatency(STAGE.STT, 200);
    vm.recordStageLatency(STAGE.LLM, 900, { operation: 'chat' });
    vm.recordStageLatency(STAGE.TTS, 400);
    vm.recordStageLatency(STAGE.CLASSIFY, 50, { emotion: 'content' });

    await handle.forceFlush();
    const hist = findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION);
    expect(hist).toBeDefined();
    expect(hist?.descriptor.unit).toBe('s');
    // 七个阶段 → 七条 data point(标签隔离)。
    expect(hist?.dataPoints.length).toBe(7);

    const turn = stagePoint(hist, STAGE.TURN);
    expect(turn?.value.count).toBe(1);
    // 1500ms → 1.5s。
    expect(turn?.value.sum).toBeCloseTo(1.5, 6);
    expect(turn?.attributes[METRIC_ATTR.PROVIDER]).toBe('deepseek');
    expect(turn?.attributes[METRIC_ATTR.MODEL]).toBe('deepseek-chat');

    const ttft = stagePoint(hist, STAGE.TTFT);
    expect(ttft?.value.sum).toBeCloseTo(0.3, 6);
    const llm = stagePoint(hist, STAGE.LLM);
    expect(llm?.attributes[METRIC_ATTR.OPERATION]).toBe('chat');
    const classify = stagePoint(hist, STAGE.CLASSIFY);
    expect(classify?.attributes[METRIC_ATTR.EMOTION]).toBe('content');
  });

  it('同阶段多条样本累计到同一 data point', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    vm.recordStageLatency(STAGE.STT, 100);
    vm.recordStageLatency(STAGE.STT, 300);
    await handle.forceFlush();

    const stt = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.STT);
    expect(stt?.value.count).toBe(2);
    expect(stt?.value.sum).toBeCloseTo(0.4, 6); // (100+300)ms = 0.4s
  });

  it('非法时长(负数 / NaN / Infinity)静默丢弃,不进直方图', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    vm.recordStageLatency(STAGE.TTS, -1);
    vm.recordStageLatency(STAGE.TTS, Number.NaN);
    vm.recordStageLatency(STAGE.TTS, Number.POSITIVE_INFINITY);
    vm.recordStageLatency(STAGE.TTS, 250); // 唯一有效样本
    await handle.forceFlush();

    const tts = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.TTS);
    expect(tts?.value.count).toBe(1);
    expect(tts?.value.sum).toBeCloseTo(0.25, 6);
  });

  it('attrs 条件展开:省略的维度键不出现(exactOptional 合规)', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    // 不传 attrs:除 stage 外无其它键。
    vm.recordStageLatency(STAGE.STT, 120);
    await handle.forceFlush();

    const stt = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.STT);
    expect(stt?.attributes[METRIC_ATTR.STAGE]).toBe(STAGE.STT);
    expect(METRIC_ATTR.PROVIDER in (stt?.attributes ?? {})).toBe(false);
    expect(METRIC_ATTR.MODEL in (stt?.attributes ?? {})).toBe(false);
    expect(METRIC_ATTR.EMOTION in (stt?.attributes ?? {})).toBe(false);
  });

  it('time helper:记同步耗时并返回原值', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    const out = vm.time(STAGE.CLASSIFY, () => 42);
    expect(out).toBe(42);
    await handle.forceFlush();
    const cp = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.CLASSIFY);
    expect(cp?.value.count).toBe(1);
  });

  it('time helper:异步透传 Promise 原值并记耗时', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    const out = await vm.time(STAGE.LLM, async () => 'ok');
    expect(out).toBe('ok');
    await handle.forceFlush();
    const lp = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.LLM);
    expect(lp?.value.count).toBe(1);
  });
});

describe('降级:未初始化 OTel 时 record 是 no-op,不崩', () => {
  it('未 init 时 recordStageLatency / time 不抛、不产生 metric', () => {
    // 不调用 initMetrics:全局是 API 默认 no-op meter。
    const vm = createVoiceMetrics(getMeter());
    expect(() => {
      vm.recordStageLatency(STAGE.TURN, 1200, { provider: 'deepseek' });
      vm.recordStageLatency(STAGE.TTFA, 800);
      const r = vm.time(STAGE.STT, () => 1);
      expect(r).toBe(1);
    }).not.toThrow();
  });
});

describe('withBudget:per-handler 延迟预算监控(§8.1 超预算只告警不杀)', () => {
  it('超预算:触发 onWarn 告警、不抛、返回原值,并记 metric', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    const warnings: BudgetWarning[] = [];

    // budget=0ms,任何耗时都超预算 → 必告警。
    const result = withBudget(
      { stage: STAGE.LLM, budgetMs: 0, onWarn: (w) => warnings.push(w), metrics: vm },
      () => 'value',
    );

    expect(result).toBe('value'); // 返回原值,不被打断
    expect(warnings.length).toBe(1);
    expect(warnings[0]?.stage).toBe(STAGE.LLM);
    expect(warnings[0]?.budgetMs).toBe(0);
    expect(warnings[0]?.durationMs).toBeGreaterThanOrEqual(0);

    await handle.forceFlush();
    const lp = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.LLM);
    expect(lp?.value.count).toBe(1); // metric 也记了
  });

  it('未超预算:不告警,返回原值', () => {
    const warnings: BudgetWarning[] = [];
    const result = withBudget(
      { stage: STAGE.STT, budgetMs: 60_000, onWarn: (w) => warnings.push(w) },
      () => 7,
    );
    expect(result).toBe(7);
    expect(warnings.length).toBe(0);
  });

  it('onWarn 自身抛错被吞,不影响主流程(只告警不杀)', () => {
    const result = withBudget(
      {
        stage: STAGE.TTS,
        budgetMs: 0,
        onWarn: () => {
          throw new Error('告警 sink 炸了');
        },
      },
      () => 'still-ok',
    );
    expect(result).toBe('still-ok');
  });

  it('fn 抛错:原样抛出(不吞业务异常),但抛前仍告警/记一条耗时', async () => {
    const { reader, exporter } = inMemory();
    handle = initMetrics({ readers: [reader], console: false });
    const vm = createVoiceMetrics(getMeter());
    const warnings: BudgetWarning[] = [];

    expect(() =>
      withBudget(
        { stage: STAGE.CLASSIFY, budgetMs: 0, onWarn: (w) => warnings.push(w), metrics: vm },
        () => {
          throw new Error('handler 失败');
        },
      ),
    ).toThrow('handler 失败');

    expect(warnings.length).toBe(1); // 失败路径同样可观测
    await handle.forceFlush();
    const cp = stagePoint(findHistogram(exporter.getMetrics(), METRIC.STAGE_DURATION), STAGE.CLASSIFY);
    expect(cp?.value.count).toBe(1);
  });

  it('异步 fn:超预算告警在 settle 后触发,透传 Promise 原值', async () => {
    const warnings: BudgetWarning[] = [];
    const result = await withBudget(
      { stage: STAGE.LLM, budgetMs: 0, onWarn: (w) => warnings.push(w) },
      async () => 'async-value',
    );
    expect(result).toBe('async-value');
    expect(warnings.length).toBe(1);
  });

  it('异步 fn 拒绝:reject 原样透传,但仍告警', async () => {
    const warnings: BudgetWarning[] = [];
    await expect(
      withBudget(
        { stage: STAGE.LLM, budgetMs: 0, onWarn: (w) => warnings.push(w) },
        async () => {
          throw new Error('async 失败');
        },
      ),
    ).rejects.toThrow('async 失败');
    expect(warnings.length).toBe(1);
  });
});
