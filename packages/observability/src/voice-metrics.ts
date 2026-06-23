/**
 * 语音 / 回合延迟 metrics 接缝(§8.1 指标侧:延迟用 Histogram,仿 LiveKit `lk.agents.turn.*`)。
 *
 * 与 metrics.ts(回合 Histogram 接缝)同构、复用同一套 OTel 骨架:
 * - 不重造 MeterProvider:阶段 Histogram 建在 `getMeter()`(`metrics.ts`)返回的全局 meter 上。
 * - 未 init OTel 时取到的是 API 默认 **no-op meter**——record 静默无开销、不抛(优雅降级,§3.2)。
 * - metric 名 / 阶段枚举 / 维度键全部收敛到 conventions.ts(单一命名,无 magic string)。
 *
 * 本文件在 metrics.ts 的「回合 / LLM 两条 Histogram」之上,补齐 §4 语音管线**各阶段**延迟:
 * 单一 `STAGE_DURATION` Histogram + `chat_a.stage` 维度区分阶段(TTFT/TTFA/STT/LLM/TTS/分类/回合)。
 *
 * 隐私(§8.1):metric 只记**数值 + 低基数维度标签**(provider/model/operation/emotion/stage),
 * **绝不**记 prompt / 转写 / 回复内容,也不放 correlation/session/turn id(高基数,属 trace 侧)。
 *
 * 注意:本切片只产 metrics 接缝,**不接 runtime 调用点**(留串行)。
 */

import { type Histogram, type Meter, type Attributes } from '@opentelemetry/api';
import { METRIC, METRIC_ATTR, type StageName } from './conventions';
import { getMeter, type TurnMetricAttributes } from './metrics';

/** Histogram 单位:统一秒(s)——与 metrics.ts / OTel / Prometheus 习惯一致,record 入参也以秒计。 */
const DURATION_UNIT = 's';

/** ms → s 换算(打点处常拿到毫秒;Histogram 统一存秒)。 */
const MS_PER_SEC = 1000;

/**
 * 阶段延迟记录器(接缝):把「记哪条 Histogram、带哪些维度」收口到一个轻量对象。
 * 调用点(后续 runtime 串行接)只管 `recordStageLatency` / `time`,不直接碰 OTel API。
 *
 * 惰性建 Histogram:构造时按当前全局 meter 建——故 init 前后都能正确工作
 * (init 前建在 no-op meter 上、record 静默;init 后用新建实例落到真 reader)。
 */
export interface VoiceMetrics {
  /**
   * 记一条某阶段延迟(**毫秒**入参,内部换算成秒入直方图)。
   * 非有限值 / 负数视为无效,静默丢弃(不污染分位,§3.2)。
   */
  recordStageLatency(stage: StageName, ms: number, attrs?: TurnMetricAttributes): void;
  /**
   * 计时 helper:跑 `fn`、记其耗时到 `stage`,返回 `fn` 的原值(同步或 Promise 均可)。
   * `fn` 抛错时**仍记一条耗时**(便于观察失败路径延迟)再把错误原样抛出——计时不吞业务异常。
   */
  time<T>(stage: StageName, fn: () => T, attrs?: TurnMetricAttributes): T;
}

/**
 * 构造语音 metrics 记录器。
 * `meter` 省略时取当前全局 meter(随 init 状态变化:no-op 或真 provider);
 * 传入显式 meter 便于测试隔离 / 多 provider 场景(与 `createTurnMetrics` 同构)。
 */
export function createVoiceMetrics(meter: Meter = getMeter()): VoiceMetrics {
  const stageHist = meter.createHistogram(METRIC.STAGE_DURATION, {
    unit: DURATION_UNIT,
    description: '语音/回合各阶段延迟(阶段走 chat_a.stage 维度)',
  });

  function recordStageLatency(stage: StageName, ms: number, attrs?: TurnMetricAttributes): void {
    recordStage(stageHist, stage, ms, attrs);
  }

  function time<T>(stage: StageName, fn: () => T, attrs?: TurnMetricAttributes): T {
    const start = now();
    let result: T;
    try {
      result = fn();
    } catch (err) {
      recordStageLatency(stage, now() - start, attrs);
      throw err;
    }
    // 异步:等结算后再记,且失败路径同样记一条(finally),再把 settle 结果原样透传。
    if (isPromise(result)) {
      return result.finally(() => {
        recordStageLatency(stage, now() - start, attrs);
      }) as T;
    }
    recordStageLatency(stage, now() - start, attrs);
    return result;
  }

  return { recordStageLatency, time };
}

function recordStage(
  hist: Histogram,
  stage: StageName,
  ms: number,
  attrs?: TurnMetricAttributes,
): void {
  // 防御:负数 / NaN / Infinity 不入直方图(避免污染分位),静默丢弃(降级,§3.2)。
  if (!Number.isFinite(ms) || ms < 0) return;
  try {
    hist.record(ms / MS_PER_SEC, toStageAttributes(stage, attrs));
  } catch {
    // record 决不抛到调用点(§3.2)。
  }
}

/**
 * 把弱类型维度 + 阶段映射到收敛后的低基数 metric 维度键;省略项不写(exactOptional 友好)。
 * 阶段(`chat_a.stage`)恒写;provider/model/operation/emotion 仅在给出时条件展开。
 */
function toStageAttributes(stage: StageName, attrs?: TurnMetricAttributes): Attributes {
  const out: Record<string, string> = { [METRIC_ATTR.STAGE]: stage };
  if (attrs === undefined) return out;
  if (attrs.provider !== undefined) out[METRIC_ATTR.PROVIDER] = attrs.provider;
  if (attrs.model !== undefined) out[METRIC_ATTR.MODEL] = attrs.model;
  if (attrs.operation !== undefined) out[METRIC_ATTR.OPERATION] = attrs.operation;
  if (attrs.emotion !== undefined) out[METRIC_ATTR.EMOTION] = attrs.emotion;
  return out;
}

/** 高精度单调时钟(ms);`performance.now()` 缺失时降级到 `Date.now()`。 */
function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isPromise<T>(v: T | Promise<T>): v is Promise<T> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { then?: unknown }).then === 'function' &&
    typeof (v as { finally?: unknown }).finally === 'function'
  );
}

// ───────────────────────────────────────────────────────────────────────────
// per-handler 延迟预算监控(§8.1:超预算只告警不杀)
// ───────────────────────────────────────────────────────────────────────────

/** 预算告警载荷(传给 `onWarn`;只含数值 + 阶段标签,无任何内容)。 */
export interface BudgetWarning {
  /** 被监控阶段。 */
  readonly stage: StageName;
  /** 实测耗时(ms)。 */
  readonly durationMs: number;
  /** 预算阈值(ms)。 */
  readonly budgetMs: number;
}

export interface BudgetMonitorOptions {
  /** 被监控阶段(也作 metric 的 `chat_a.stage` 维度)。 */
  readonly stage: StageName;
  /** 延迟预算(ms);实测 > 此值即告警。 */
  readonly budgetMs: number;
  /** 超预算回调(告警 sink:打日志 / 发事件)。**只告警不杀**——本身抛错也被吞,不影响主流程。 */
  readonly onWarn?: (warning: BudgetWarning) => void;
  /** 同时把耗时记入阶段 Histogram 的记录器(省略则只告警不记 metric)。 */
  readonly metrics?: VoiceMetrics;
  /** 记 metric 时附带的低基数维度(provider/model/...)。 */
  readonly attrs?: TurnMetricAttributes;
}

/**
 * per-handler 延迟预算监控包装器(§3.2 延迟预算 + §8.1「超预算只告警不杀」)。
 *
 * 跑 `fn`、测耗时:可选记入阶段 Histogram;**超阈值则触发 `onWarn` 告警但绝不打断**——
 * 返回 `fn` 的原值(同步直接返回 / 异步透传 Promise)。`fn` 自身抛错原样抛出(不吞业务异常),
 * 但**抛错前仍测一次耗时并按需告警/记录**(失败路径同样要可观测)。`onWarn` 自身异常被吞(§3.2)。
 *
 * 与 `VoiceMetrics.time` 的区别:`time` 只记 metric;本包装器在记 metric 之外加「超预算告警」语义。
 */
export function withBudget<T>(opts: BudgetMonitorOptions, fn: () => T): T {
  const start = now();

  const settle = (durationMs: number): void => {
    opts.metrics?.recordStageLatency(opts.stage, durationMs, opts.attrs);
    if (durationMs > opts.budgetMs && opts.onWarn !== undefined) {
      try {
        opts.onWarn({ stage: opts.stage, durationMs, budgetMs: opts.budgetMs });
      } catch {
        // 告警 sink 自身异常吞掉:可观测性不得拖垮主流程(§3.2)。
      }
    }
  };

  let result: T;
  try {
    result = fn();
  } catch (err) {
    settle(now() - start);
    throw err;
  }
  if (isPromise(result)) {
    return result.finally(() => {
      settle(now() - start);
    }) as T;
  }
  settle(now() - start);
  return result;
}
