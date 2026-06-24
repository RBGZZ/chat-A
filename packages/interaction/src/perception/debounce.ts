/**
 * 三层去抖的**纯函数核**(§12.1 / §3.2 决策 2)。
 *
 * 三层:
 *   1) 源内边沿 latch(`edgeLatch`,纯函数:旧态 + 新读数 → 新态 + 是否触发边沿)——有状态但状态外置,
 *      由调用方持有,函数本身无副作用、同输入同输出,可 golden test。
 *   2) 滑窗 detector(`slidingWindowDetect`,纯函数:窗口内样本 + 阈值配置 → 是否"持续命中")。
 *   3) 0.3s 聚合窗合并(`aggregateWindow`,纯函数:同窗多条 raw → 合并后的 signal 草案)。
 *
 * 阈值/窗口全部走 config 入参(行为即配置,§3.2),不内嵌魔数。
 */

/** 边沿 latch 的外置状态。 */
export interface EdgeState {
  /** 上一次的电平(true=已"按下"/超阈)。 */
  readonly level: boolean;
}

export interface EdgeResult {
  readonly state: EdgeState;
  /** 是否发生上升沿(false→true)。下游据此触发,避免高电平持续重复触发。 */
  readonly rising: boolean;
  /** 是否发生下降沿(true→false)。 */
  readonly falling: boolean;
}

/**
 * 源内边沿 latch(第 1 层)。`reading` 为本次是否超阈的布尔读数。
 * 纯函数:`(旧态, 读数) → (新态, 边沿)`。状态由调用方持有(源自管)。
 */
export function edgeLatch(prev: EdgeState, reading: boolean): EdgeResult {
  const rising = !prev.level && reading;
  const falling = prev.level && !reading;
  return { state: { level: reading }, rising, falling };
}

export const INITIAL_EDGE_STATE: EdgeState = { level: false };

/** 滑窗 detector 配置。 */
export interface SlidingWindowConfig {
  /** 窗口时长(ms):只看 `[now-windowMs, now]` 内的样本。 */
  readonly windowMs: number;
  /** 窗口内命中样本数达此值才判"持续命中"(去抖,过滤孤立尖峰)。 */
  readonly minHits: number;
}

/** 一个带时间戳的布尔样本。 */
export interface Sample {
  readonly atMs: number;
  readonly hit: boolean;
}

export interface SlidingWindowResult {
  /** 是否判定为"持续命中"(窗口内 hit 数 ≥ minHits)。 */
  readonly triggered: boolean;
  /** 窗口内的命中数(供 confidence 计算)。 */
  readonly hits: number;
  /** 窗口内的样本总数。 */
  readonly total: number;
}

/**
 * 滑窗 detector(第 2 层,**纯函数**)。给定样本序列、当前时刻与阈值配置,
 * 输出是否触发 + 命中统计。同输入同输出,阈值取自 config —— 可写 golden test。
 */
export function slidingWindowDetect(
  samples: readonly Sample[],
  nowMs: number,
  config: SlidingWindowConfig,
): SlidingWindowResult {
  const from = nowMs - config.windowMs;
  let hits = 0;
  let total = 0;
  for (const s of samples) {
    if (s.atMs < from || s.atMs > nowMs) continue;
    total += 1;
    if (s.hit) hits += 1;
  }
  return { triggered: hits >= config.minHits, hits, total };
}

/** 聚合窗内待合并的一条 raw(已通过前两层,描述化前的草案)。 */
export interface AggregateInput {
  readonly kind: string;
  readonly description: string;
  readonly atMs: number;
  /** 本条的局部置信度(0..1);聚合时取加权/最大。 */
  readonly confidence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** 聚合后的 signal 草案(Hub 据此 fire `signal:perception`)。 */
export interface AggregatedSignal {
  readonly kind: string;
  readonly description: string;
  readonly confidence: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** 本 signal 合并了多少条 raw(可追溯"七嘴八舌"被压成几条)。 */
  readonly mergedCount: number;
}

export interface AggregateConfig {
  /** 聚合窗时长(ms),默认 300(0.3s)。 */
  readonly windowMs: number;
}

export const DEFAULT_AGGREGATE_CONFIG: AggregateConfig = { windowMs: 300 };

/**
 * 0.3s 聚合窗合并(第 3 层,**纯函数**)。把 `[now-windowMs, now]` 内的多条 raw 草案
 * **按 kind 合并**为有限个 signal(同 kind 取最高 confidence 的描述,合并 metadata,
 * confidence 取窗内最大),避免多源/多次抖动"七嘴八舌"。
 *
 * 同输入同输出:输出按 kind 升序排列,确定可测。
 */
export function aggregateWindow(
  inputs: readonly AggregateInput[],
  nowMs: number,
  config: AggregateConfig = DEFAULT_AGGREGATE_CONFIG,
): AggregatedSignal[] {
  const from = nowMs - config.windowMs;
  const byKind = new Map<string, AggregateInput[]>();
  for (const i of inputs) {
    if (i.atMs < from || i.atMs > nowMs) continue;
    const list = byKind.get(i.kind) ?? [];
    list.push(i);
    byKind.set(i.kind, list);
  }
  const out: AggregatedSignal[] = [];
  for (const [kind, list] of byKind) {
    // 取窗内置信度最高者作代表描述;confidence 取最大;metadata 浅合并(后者覆盖前者)。
    let best = list[0]!;
    let maxConf = best.confidence;
    let merged: Record<string, unknown> = { ...(best.metadata ?? {}) };
    for (const cur of list.slice(1)) {
      if (cur.confidence > best.confidence) best = cur;
      if (cur.confidence > maxConf) maxConf = cur.confidence;
      merged = { ...merged, ...(cur.metadata ?? {}) };
    }
    const hasMeta = Object.keys(merged).length > 0;
    out.push({
      kind,
      description: best.description,
      confidence: maxConf,
      ...(hasMeta ? { metadata: merged } : {}),
      mergedCount: list.length,
    });
  }
  // 确定性排序(便于 golden test)。
  out.sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return out;
}
