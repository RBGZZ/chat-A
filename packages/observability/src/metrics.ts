/**
 * OTel 延迟 metrics 接缝(§8.1 指标侧:延迟用 Histogram,仿 LiveKit `lk.agents.turn.*`)。
 *
 * 与 telemetry.ts(trace 骨架)同构:
 * - `initMetrics()` 装一个全局 MeterProvider(可注入 in-memory reader 供测试 / console 便于本地观察)。
 * - 未初始化时取到的是 OTel API 默认的 **no-op meter**——record 静默无开销(优雅降级,§3.2)。
 * - metric 名 / 维度键全部收敛到 conventions.ts(单一命名,无 magic string)。
 *
 * 注意:本切片只产 metrics 接缝,**不接 runtime 调用点**(留串行)。
 */

import { metrics, type Histogram, type Meter, type Attributes } from '@opentelemetry/api';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  ConsoleMetricExporter,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { METRIC, METRIC_ATTR } from './conventions';

const SERVICE_NAME = 'chat-a';

/** Histogram 单位:统一秒(s)——与 OTel/Prometheus 习惯一致,record 入参也以秒计。 */
const DURATION_UNIT = 's';

export interface InitMetricsOptions {
  readonly serviceName?: string;
  /**
   * 是否加控制台 exporter(周期导出到 stdout,便于本地观察)。
   * 省略时:无注入 reader 才默认开,有则不加噪(与 telemetry.ts 的 console 取舍同构)。
   */
  readonly console?: boolean;
  /**
   * 注入额外 MetricReader(测试用 in-memory `PeriodicExportingMetricReader` + InMemoryMetricExporter;
   * 未来接 OTLP / Prometheus 的 reader 也走这里)。
   */
  readonly readers?: readonly MetricReader[];
  /** console exporter 的导出周期(ms),默认 60000;仅在 console 开启时生效。 */
  readonly consoleExportIntervalMs?: number;
  /** shutdown 硬超时(ms):树莓派上 flush 可能卡(§8.1),默认 3000。 */
  readonly shutdownTimeoutMs?: number;
}

export interface MetricsHandle {
  /** 平滑关闭(带硬超时);进程退出前调用,确保最后一批 metric 导出又不卡死。 */
  shutdown(): Promise<void>;
  /** 主动触发一次收集 + 导出(测试里断言前 flush 用)。 */
  forceFlush(): Promise<void>;
}

let active: MeterProvider | undefined;

/**
 * 初始化 metrics 骨架。幂等:重复调用返回同一 provider 的 handle(不重复注册)。
 * 未调用本函数时,`getMeter()` 取到 no-op meter——record 零成本、不污染(降级路径)。
 */
export function initMetrics(opts: InitMetricsOptions = {}): MetricsHandle {
  const timeoutMs = opts.shutdownTimeoutMs ?? 3000;
  if (active !== undefined) {
    return makeHandle(active, timeoutMs);
  }

  const readers: MetricReader[] = [...(opts.readers ?? [])];
  const wantConsole = opts.console ?? readers.length === 0;
  if (wantConsole) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new ConsoleMetricExporter(),
        exportIntervalMillis: opts.consoleExportIntervalMs ?? 60000,
      }),
    );
  }

  const provider = new MeterProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: opts.serviceName ?? SERVICE_NAME }),
    readers,
  });
  metrics.setGlobalMeterProvider(provider);
  active = provider;
  return makeHandle(provider, timeoutMs);
}

function makeHandle(provider: MeterProvider, timeoutMs: number): MetricsHandle {
  return {
    async forceFlush(): Promise<void> {
      try {
        await provider.forceFlush();
      } catch {
        // flush 异常吞掉:可观测性不得拖垮主流程(§3.2)。
      }
    },
    async shutdown(): Promise<void> {
      const provShutdown = provider.shutdown();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const guard = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      });
      try {
        await Promise.race([provShutdown, guard]);
      } catch {
        // shutdown 自身异常吞掉(§3.2)。
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (active === provider) {
          active = undefined;
          // 还原全局为 API 默认 no-op,避免关后还指向已死 provider。
          metrics.disable();
        }
      }
    },
  };
}

/** 取 chat-A 的 meter;未 init 时返回 API 默认 no-op meter(不污染测试/生产降级)。 */
export function getMeter(): Meter {
  return metrics.getMeter(SERVICE_NAME);
}

/**
 * 回合延迟 metrics 记录器(接缝):把"记哪些 Histogram、带哪些维度"收口到一个轻量对象,
 * 调用点(后续 runtime 串行接)只管 `recordTurn/recordLlm`,不直接碰 OTel API。
 *
 * 惰性建 Histogram:首次 record 时按当前全局 meter 建——故 init 前后都能正确工作
 * (init 前建在 no-op meter 上、record 静默;init 后重建一个会落到真 reader 的实例)。
 */
export interface TurnMetricAttributes {
  readonly provider?: string;
  readonly model?: string;
  readonly operation?: string;
  readonly emotion?: string;
}

export interface TurnMetrics {
  /** 记一条回合级端到端延迟(秒)。durationSec < 0 或非有限值视为无效,静默丢弃。 */
  recordTurn(durationSec: number, attrs?: TurnMetricAttributes): void;
  /** 记一条 LLM 调用延迟(秒)。 */
  recordLlm(durationSec: number, attrs?: TurnMetricAttributes): void;
}

/**
 * 构造回合 metrics 记录器。
 * `meter` 省略时取当前全局 meter(随 init 状态变化:no-op 或真 provider)。
 * 传入显式 meter 便于测试隔离 / 多 provider 场景。
 */
export function createTurnMetrics(meter: Meter = getMeter()): TurnMetrics {
  const turn = makeDurationHistogram(meter, METRIC.TURN_DURATION, '回合级端到端延迟');
  const llm = makeDurationHistogram(meter, METRIC.LLM_DURATION, 'LLM 调用延迟');
  return {
    recordTurn(durationSec, attrs): void {
      record(turn, durationSec, attrs);
    },
    recordLlm(durationSec, attrs): void {
      record(llm, durationSec, attrs);
    },
  };
}

function makeDurationHistogram(meter: Meter, name: string, description: string): Histogram {
  return meter.createHistogram(name, { unit: DURATION_UNIT, description });
}

function record(hist: Histogram, durationSec: number, attrs?: TurnMetricAttributes): void {
  // 防御:负数 / NaN / Infinity 不入直方图(避免污染分位),静默丢弃(降级,§3.2)。
  if (!Number.isFinite(durationSec) || durationSec < 0) return;
  try {
    hist.record(durationSec, toAttributes(attrs));
  } catch {
    // record 决不抛到调用点(§3.2)。
  }
}

/** 把弱类型的维度对象映射到收敛后的 metric 维度键(低基数);省略项不写(exactOptional 友好)。 */
function toAttributes(attrs?: TurnMetricAttributes): Attributes {
  const out: Record<string, string> = {};
  if (attrs === undefined) return out;
  if (attrs.provider !== undefined) out[METRIC_ATTR.PROVIDER] = attrs.provider;
  if (attrs.model !== undefined) out[METRIC_ATTR.MODEL] = attrs.model;
  if (attrs.operation !== undefined) out[METRIC_ATTR.OPERATION] = attrs.operation;
  if (attrs.emotion !== undefined) out[METRIC_ATTR.EMOTION] = attrs.emotion;
  return out;
}
