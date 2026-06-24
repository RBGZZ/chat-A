import type { DatabaseSync } from 'node:sqlite';
import { loadDatabaseSync } from './sqlite-loader';
import type { DecisionTraceRecalled } from './decision-trace';

/**
 * 决策 trace **只读**统计聚合(§8.1 在"无条件全量落库 + 单回合查看"之上补"跨回合聚合视图")。
 *
 * 关键纪律:stats 纯只读——只 SELECT 聚合,绝不建表/迁移/写,亦不依赖也不触碰
 * `SqliteDecisionTraceSink` 的写契约,也不复用/不改 `DecisionTraceReader` 的现有契约
 * (单向:库 → stats,与 reader 并列的姊妹只读模块)。
 * 库不存在 / 表缺失 / 损坏 → 优雅降级(空统计对象 + 告警,不崩,§3.2)。
 */

/** 取值 → 回合计数(emotion / posture / provider / session 各自一份)。 */
export type CountDistribution = Record<string, number>;

/** 回合延迟统计:样本数、均值、分位(p50/p95)。 */
export interface LatencyStats {
  /** 参与统计的样本数(= 总回合数)。 */
  readonly count: number;
  /** 均值(ms);无样本时为 0。 */
  readonly mean: number;
  /** 中位数 p50(ms);无样本时为 0。 */
  readonly p50: number;
  /** p95(ms);无样本时为 0。 */
  readonly p95: number;
}

/** 召回命中统计。 */
export interface RecallStats {
  /** 每回合 recalled 数组长度的均值;无样本时为 0。 */
  readonly meanRecalledLen: number;
  /** 有召回(长度 > 0)的回合占比 ∈ [0,1];无样本时为 0。 */
  readonly recalledRatio: number;
}

/** 一次聚合的完整结果(可重建"这段时间她的分布/延迟/召回画像")。 */
export interface DecisionTraceStatsResult {
  /** 全库总回合数。 */
  readonly totalTurns: number;
  /** emotion 取值 → 计数。 */
  readonly emotionCounts: CountDistribution;
  /** posture 取值 → 计数(只统计有姿态的回合,NULL 排除)。 */
  readonly postureCounts: CountDistribution;
  /** provider 取值 → 计数。 */
  readonly providerCounts: CountDistribution;
  /** 回合延迟统计。 */
  readonly latency: LatencyStats;
  /** sessionId → 回合计数。 */
  readonly sessionTurnCounts: CountDistribution;
  /** 召回命中统计。 */
  readonly recall: RecallStats;
}

export interface DecisionTraceStatsOptions {
  /** 库文件路径;':memory:' 仅供测试(只读内存库需同进程预填)。 */
  readonly path: string;
  /** 告警回调(降级层);默认 console.warn。降级时记录而非抛出。 */
  readonly onWarn?: (err: unknown, op: string) => void;
}

function asNumber(v: unknown): number {
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : Number(v);
}

/** 安全 JSON 解析:失败回退默认值(库被外部改坏也不崩)。 */
function parseJson<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string') return fallback;
  try {
    return JSON.parse(v) as T;
  } catch {
    return fallback;
  }
}

/**
 * nearest-rank 分位:对**已升序**的样本取第 p 百分位。
 * rank = ceil(p/100 * n),idx = clamp(rank - 1, 0, n-1)。确定性、可写 golden:
 *   p50 of [10,20,30,40] → rank=2 → idx=1 → 20;p95 → rank=4 → idx=3 → 40。
 * n=0 → 0;n=1 → 唯一值。
 */
export function nearestRankPercentile(sortedAsc: readonly number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0] as number;
  const rank = Math.ceil((p / 100) * n);
  const idx = Math.min(Math.max(rank - 1, 0), n - 1);
  return sortedAsc[idx] as number;
}

/** 空统计对象(降级/空库时返回,调用方据 totalTurns=0 判断"无数据")。 */
function emptyResult(): DecisionTraceStatsResult {
  return {
    totalTurns: 0,
    emotionCounts: {},
    postureCounts: {},
    providerCounts: {},
    latency: { count: 0, mean: 0, p50: 0, p95: 0 },
    sessionTurnCounts: {},
    recall: { meanRecalledLen: 0, recalledRatio: 0 },
  };
}

export class DecisionTraceStats {
  readonly #onWarn: (err: unknown, op: string) => void;
  readonly #path: string;
  /** 只读句柄;打开失败时为 null(后续聚合走降级)。 */
  #db: DatabaseSync | null = null;

  constructor(opts: DecisionTraceStatsOptions) {
    this.#onWarn = opts.onWarn ?? ((err, op) => console.warn(`[decision-trace-stats] ${op} 告警`, err));
    this.#path = opts.path;
    try {
      // 只读打开:不创建库、不写。库不存在/损坏在此抛 → 降级。
      // 注意:node:sqlite 选项名为 `readOnly`(大写 O);小写 `readonly` 不报错但**不强制只读**。
      this.#db = new (loadDatabaseSync())(this.#path, { readOnly: true });
    } catch (err) {
      this.#onWarn(err, 'open');
      this.#db = null;
    }
  }

  /**
   * 计算一次完整聚合。任一步失败 → 整体降级为空统计 + 告警,不崩。
   * 设计取舍:单次调用做全套(开发期诊断一把抓);量级巨大时可改增量/缓存,本期从简。
   */
  compute(): DecisionTraceStatsResult {
    const db = this.#db;
    if (db === null) return emptyResult();
    try {
      const totalTurns = this.#totalTurns(db);
      return {
        totalTurns,
        emotionCounts: this.#countBy(db, 'emotion'),
        // posture 可空:只统计有姿态的回合(NULL 排除)。
        postureCounts: this.#countBy(db, 'posture', true),
        providerCounts: this.#countBy(db, 'provider'),
        latency: this.#latency(db),
        sessionTurnCounts: this.#countBy(db, 'session_id'),
        recall: this.#recall(db, totalTurns),
      } satisfies DecisionTraceStatsResult;
    } catch (err) {
      // 表缺失/损坏 → 整体降级为空统计。
      this.#onWarn(err, 'compute');
      return emptyResult();
    }
  }

  #totalTurns(db: DatabaseSync): number {
    const row = db.prepare('SELECT COUNT(*) AS c FROM decision_traces').get() as Record<string, unknown>;
    return asNumber(row['c']);
  }

  /**
   * 按某列 GROUP BY 计数。`excludeNull=true` 时排除该列为 NULL 的行(用于可空 posture)。
   * 列名为受控字面量(本模块内部传入),非用户输入,无注入面。
   */
  #countBy(db: DatabaseSync, column: string, excludeNull = false): CountDistribution {
    const where = excludeNull ? `WHERE ${column} IS NOT NULL` : '';
    const sql = `SELECT ${column} AS k, COUNT(*) AS c FROM decision_traces ${where} GROUP BY ${column}`;
    const rows = db.prepare(sql).all() as Record<string, unknown>[];
    const dist: CountDistribution = {};
    for (const row of rows) {
      const key = row['k'];
      if (key === null || key === undefined) continue;
      dist[String(key)] = asNumber(row['c']);
    }
    return dist;
  }

  #latency(db: DatabaseSync): LatencyStats {
    // 取全部 latency_ms 升序,均值与分位都在 JS 侧算(node:sqlite 无内置分位函数)。
    const rows = db
      .prepare('SELECT latency_ms AS v FROM decision_traces ORDER BY latency_ms ASC')
      .all() as Record<string, unknown>[];
    const values = rows.map((r) => asNumber(r['v']));
    const count = values.length;
    if (count === 0) return { count: 0, mean: 0, p50: 0, p95: 0 };
    const sum = values.reduce((a, b) => a + b, 0);
    return {
      count,
      mean: sum / count,
      p50: nearestRankPercentile(values, 50),
      p95: nearestRankPercentile(values, 95),
    };
  }

  #recall(db: DatabaseSync, totalTurns: number): RecallStats {
    if (totalTurns === 0) return { meanRecalledLen: 0, recalledRatio: 0 };
    // recalled 是 JSON 数组文本:取出在 JS 侧 parse 算长度(解析失败按 0 容错)。
    const rows = db.prepare('SELECT recalled AS r FROM decision_traces').all() as Record<string, unknown>[];
    let totalLen = 0;
    let withRecall = 0;
    for (const row of rows) {
      const arr = parseJson<DecisionTraceRecalled[]>(row['r'], []);
      const len = Array.isArray(arr) ? arr.length : 0;
      totalLen += len;
      if (len > 0) withRecall += 1;
    }
    const n = rows.length;
    return {
      meanRecalledLen: n === 0 ? 0 : totalLen / n,
      recalledRatio: n === 0 ? 0 : withRecall / n,
    };
  }

  /** 释放只读句柄。 */
  close(): void {
    if (this.#db === null) return;
    try {
      this.#db.close();
    } catch (err) {
      this.#onWarn(err, 'close');
    } finally {
      this.#db = null;
    }
  }
}
