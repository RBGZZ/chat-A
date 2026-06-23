/**
 * 动态 endpointing(§4 行 173 + §5b LiveKit 策略 行 101 + TEN 3 态 行 102)。
 *
 * 这是本包**唯一完整实现 + 重点测试**的部分:纯函数 + 极小状态(两个 EMA),不碰真模型/真时钟。
 *
 * 核心算法(仿 LiveKit turn-detector「抄策略不抄模型」):
 *   1. EOU 模型给出「已说完」概率 eouProb;
 *   2. 概率高(≥ unlikelyThreshold)→「多半说完了」→ 目标等待窗趋向 minEndpointingDelay(早接话);
 *      概率低(< unlikelyThreshold)→「多半没说完」→ 目标等待窗趋向 maxEndpointingDelay(多等等);
 *   3. 当前静音时长 ≥ 目标等待窗 → 该接话(EOU=Finished);否则继续等(Unfinished)。
 *   4. 两个 EMA(α≈0.9)分别学「句内停顿」(说话期短停)与「轮间停顿」(真结束前的停顿),
 *      用学到的轮间停顿微调目标窗(自校准延迟预算:实测停顿越长,窗适当放宽)。
 *
 * 全部阈值/延迟/α 来自注入的 EndpointingConfig(config.ts),无 magic number。
 */
import {
  thresholdsForLang,
  type EndpointingConfig,
  type LangEndpointingThresholds,
} from './config';

/**
 * TEN 3 态语义 EOU 输出契约(§5b 行 102):
 *   - Finished   —— 说完了,该接话。
 *   - Unfinished —— 还没说完(思考停顿),别抢话,继续等。
 *   - Wait       —— 显式「别说话」(对接硬打断/用户明确要 agent 闭嘴);比二元静音丰富。
 */
export type TurnState = 'Finished' | 'Unfinished' | 'Wait';

/** endpointing 决策输入:EOU 概率 + 当前静音时长 + 语种(选 per-language 阈值)。 */
export interface EndpointingInput {
  /** EOU 模型输出的「已说完」概率(0~1);真 Smart-Turn v3 推理得到,测试可直接注入。 */
  readonly eouProb: number;
  /** 自最后一次有声以来的静音时长(ms);由 VAD/时钟侧喂入,本函数不读真实时间。 */
  readonly silenceMs: number;
  /** 语种码(zh/en/…),决定取哪组 per-language 阈值。 */
  readonly lang: string;
  /** 上游若已判定为显式「别说话」,置 true → 直接 Wait(对接硬打断通道)。省略=false。 */
  readonly forceWait?: boolean;
}

/** endpointing 决策输出:是否该接话 + TEN 3 态 + 本次用的目标等待窗(便于 trace/调参)。 */
export interface EndpointingDecision {
  /** 是否该接话(= state === 'Finished')。 */
  readonly shouldEndpoint: boolean;
  /** TEN 3 态。 */
  readonly state: TurnState;
  /** 本次计算出的目标等待窗(ms);静音超过它即 Finished。 */
  readonly targetDelayMs: number;
}

/**
 * 据 EOU 概率把目标等待窗在 [minDelay, maxDelay] 间线性插值(纯函数,核心数学)。
 *
 *   prob ≥ unlikelyThreshold:从「阈值处 = maxDelay」线性插到「prob=1 处 = minDelay」。
 *   prob < unlikelyThreshold:更没把握说完 → 钳在 maxDelay(最多等)。
 *
 * 即:越自信说完(prob 越高)窗越短越早接话;越不自信窗越长越耐心。返回值恒落在 [min, max]。
 */
export function targetDelayFor(
  eouProb: number,
  th: LangEndpointingThresholds,
): number {
  const { unlikelyThreshold, minEndpointingDelayMs, maxEndpointingDelayMs } = th;
  const p = clamp01(eouProb);
  if (p < unlikelyThreshold) {
    return maxEndpointingDelayMs;
  }
  // 阈值→1 区间归一化:t=0 在阈值处(→max),t=1 在 prob=1 处(→min)。
  const denom = 1 - unlikelyThreshold;
  const t = denom <= 0 ? 1 : (p - unlikelyThreshold) / denom;
  return lerp(maxEndpointingDelayMs, minEndpointingDelayMs, t);
}

/**
 * 纯决策函数:给定 (EOU 概率, 静音时长, 语种) → 是否接话 + TEN 3 态。
 * 不持有状态、不读时钟 —— 完全可测、可重放(承可追溯性原则)。
 *
 * @param learnedTurnGapMs 可选:DynamicEndpointing 学到的「轮间停顿」EMA,
 *        用于把目标窗下限抬到「至少等到用户惯常的轮间停顿」(自校准)。省略则不调整。
 */
export function decideEndpointing(
  input: EndpointingInput,
  cfg: EndpointingConfig,
  learnedTurnGapMs?: number,
): EndpointingDecision {
  if (input.forceWait === true) {
    return { shouldEndpoint: false, state: 'Wait', targetDelayMs: 0 };
  }
  const th = thresholdsForLang(cfg, input.lang);
  let target = targetDelayFor(input.eouProb, th);
  // 自校准:若学到的轮间停顿比当前目标窗还长,适度抬高目标窗(但不超过 maxDelay 兜底)。
  if (learnedTurnGapMs !== undefined && learnedTurnGapMs > target) {
    target = Math.min(learnedTurnGapMs, th.maxEndpointingDelayMs);
  }
  const shouldEndpoint = input.silenceMs >= target;
  return {
    shouldEndpoint,
    state: shouldEndpoint ? 'Finished' : 'Unfinished',
    targetDelayMs: target,
  };
}

/**
 * 指数移动平均(EMA):`next = α·sample + (1-α)·prev`(α 越大越跟手最新样本)。
 * 首样本直接作为初值(无冷启动偏置)。
 */
export class Ema {
  private value: number | undefined;

  constructor(private readonly alpha: number) {}

  /** 喂入一个样本,返回更新后的均值。 */
  update(sample: number): number {
    this.value =
      this.value === undefined
        ? sample
        : this.alpha * sample + (1 - this.alpha) * this.value;
    return this.value;
  }

  /** 当前均值;尚无样本时返回 undefined。 */
  get current(): number | undefined {
    return this.value;
  }

  reset(): void {
    this.value = undefined;
  }
}

/**
 * 动态 endpointing 状态器:持两个 EMA(句内停顿 / 轮间停顿,α 同来自 config)。
 * - 句内停顿(intra-utterance):说话期内的短停顿,用于「别把思考停顿当结束」。
 * - 轮间停顿(turn-gap):用户真说完前的停顿,用于自校准目标窗下限。
 *
 * 本类只「学」与「决策」,不读真实时间:停顿样本由 VAD/时钟侧测好后喂入(确定性可测)。
 */
export class DynamicEndpointing {
  private readonly intraPause: Ema;
  private readonly turnGap: Ema;

  constructor(private readonly cfg: EndpointingConfig) {
    this.intraPause = new Ema(cfg.emaAlpha);
    this.turnGap = new Ema(cfg.emaAlpha);
  }

  /** 学一个「句内停顿」样本(ms)。 */
  observeIntraPause(ms: number): number {
    return this.intraPause.update(ms);
  }

  /** 学一个「轮间停顿」样本(ms)。 */
  observeTurnGap(ms: number): number {
    return this.turnGap.update(ms);
  }

  /** 当前学到的句内停顿 EMA(无样本则 undefined)。 */
  get learnedIntraPauseMs(): number | undefined {
    return this.intraPause.current;
  }

  /** 当前学到的轮间停顿 EMA(无样本则 undefined)。 */
  get learnedTurnGapMs(): number | undefined {
    return this.turnGap.current;
  }

  /** 用当前学到的轮间停顿做自校准决策(转调纯函数 decideEndpointing)。 */
  decide(input: EndpointingInput): EndpointingDecision {
    return decideEndpointing(input, this.cfg, this.turnGap.current);
  }

  reset(): void {
    this.intraPause.reset();
    this.turnGap.reset();
  }
}

// ───────────────────────────── 小工具(纯函数)─────────────────────────────

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function lerp(a: number, b: number, t: number): number {
  const tt = t < 0 ? 0 : t > 1 ? 1 : t;
  return a + (b - a) * tt;
}
