/**
 * 主动候选源(缝 3,承 canonical §7「真候选生成」):把既有技能(open-thread 未了话题 /
 * idle-emotion-arc 情绪弧)的「真实候选发言」喂进主动回合决策回路,**取代** MVP 用 signal 描述当占位。
 *
 * standalone(§3.1):只依赖包内既有端口/渲染(`OpenThreadPort` + `renderFollowUpText`、
 * `PresencePort` + `renderArcText`),**不依赖 `@chat-a/memory`/runtime**;真记忆适配由装配层用
 * memory 提供 `OpenThreadPort`/`PresencePort` 实现注入(本切片用假端口可测)。
 *
 * 关键约束:候选只是**喂料**——决策 LLM 仍是唯一「是否值得说」裁决(schema 约束 + 概率闸 +
 * 失败退 silent + 落 trace,全不变);候选多≠更爱说,restraint-first 不被候选数量削弱。
 */
import {
  DEFAULT_IDLE_EMOTION_ARC_OPTIONS,
  renderArcText,
  type IdleArc,
} from './idle-emotion-arc-skill';
import type { EmotionIntensityPort, PresencePort } from './idle-emotion-arc';
import {
  DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS,
  renderFollowUpText,
} from './open-thread-skill';
import type { OpenThread, OpenThreadPort } from './open-thread';
import type { Clock } from './types';

/** 候选源 gather 的上下文(本 tick 触发它的 signal 线索;候选源可据此筛选/丰富)。 */
export interface CandidateGatherContext {
  /** 触发本 tick 的 signal kind(如 `signal:temporal:tick`)。 */
  readonly signalKind: string;
  /** signal 携带的描述(可选;候选源可作线索)。 */
  readonly description?: string;
}

/**
 * 主动候选源(承 §3.1 依赖倒置):据当前 signal/context 产出真实候选发言。
 * 返回空数组 = 本 tick 无可说(调用方据此回落现状占位或交决策 LLM 判沉默)。
 */
export interface ProactiveCandidateSource {
  gather(ctx: CandidateGatherContext): Promise<readonly string[]> | readonly string[];
}

/** open-thread 候选源旋钮(仅取 cadence 无关的新鲜度窗口;cadence 节流由技能自身负责,这里只挑值得渲染的)。 */
export interface OpenThreadCandidateOptions {
  /** 线索「太新」下限(ms):距上次提及不足此值的话题不渲染(除非到 due)。默认沿用技能默认。 */
  readonly minFreshnessMs: number;
  /** 线索「陈旧」上限(ms):距上次提及超过此值的话题不主动翻(除非到 due)。默认沿用技能默认。 */
  readonly staleAfterMs: number;
  /** 最多产出几条候选(择「最值得」前 N;默认 1,克制优先)。 */
  readonly maxCandidates: number;
}

export const DEFAULT_OPEN_THREAD_CANDIDATE_OPTIONS: OpenThreadCandidateOptions = {
  minFreshnessMs: DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS.minFreshnessMs,
  staleAfterMs: DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS.staleAfterMs,
  maxCandidates: 1,
};

/**
 * open-thread 候选源:从 `OpenThreadPort` 读未了话题,挑「值得回扣」的前 N 条渲染为候选语。
 * 取舍与技能 `#judge` 同范式(到 due 强信号;否则新鲜度落窗内),但**不做 cadence 节流**
 * (节流属技能/决策回路;候选源只产「此刻有哪些值得说的话」);排序用「到 due 优先 + 越新鲜越前」。
 */
export function openThreadCandidateSource(
  port: OpenThreadPort,
  clock: Clock,
  options?: Partial<OpenThreadCandidateOptions>,
): ProactiveCandidateSource {
  const opts: OpenThreadCandidateOptions = { ...DEFAULT_OPEN_THREAD_CANDIDATE_OPTIONS, ...options };
  return {
    async gather(): Promise<readonly string[]> {
      const now = clock.now();
      const threads = await port.listOpenThreads();
      const worthy = threads
        .map((t) => ({ thread: t, score: scoreThread(t, now, opts) }))
        .filter((x): x is { thread: OpenThread; score: number } => x.score !== null)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, opts.maxCandidates));
      return worthy.map((x) => renderFollowUpText(x.thread));
    },
  };
}

/** 单条话题「是否值得 + 排序分」:不值得返回 null;值得返回分值(到 due 基线极高)。 */
function scoreThread(thread: OpenThread, now: number, opts: OpenThreadCandidateOptions): number | null {
  const isDue = thread.dueAtMs !== undefined && now >= thread.dueAtMs;
  if (isDue) return 1_000_000 + (now - (thread.dueAtMs ?? now));
  const sinceMention = now - thread.lastMentionedAtMs;
  if (sinceMention < opts.minFreshnessMs) return null; // 太新,不急
  if (sinceMention > opts.staleAfterMs) return null; // 太旧,不翻
  return Math.max(0, opts.staleAfterMs - sinceMention); // 越新鲜越靠前
}

/** idle-arc 候选源旋钮(想念/重逢的 idle 门槛;沿用技能默认)。 */
export interface IdleArcCandidateOptions {
  /** 想念阈值(ms):idle 超此值产出一条「想念」候选。默认沿用技能默认。 */
  readonly missThresholdMs: number;
  /** 默认情绪强度([0,1];无 emotion 端口时用;仅调语气)。默认沿用技能默认。 */
  readonly defaultArcIntensity: number;
}

export const DEFAULT_IDLE_ARC_CANDIDATE_OPTIONS: IdleArcCandidateOptions = {
  missThresholdMs: DEFAULT_IDLE_EMOTION_ARC_OPTIONS.missThresholdMs,
  defaultArcIntensity: DEFAULT_IDLE_EMOTION_ARC_OPTIONS.defaultArcIntensity,
};

/**
 * idle-arc 候选源:据在场感(idle 时长)产出情绪弧候选语。
 * 本切片产「想念」候选(idle 超阈值即渲染);重逢的 episode 轮转去重属技能职责(候选源只产「此刻
 * 情绪上有什么值得说」),故只据当前 idle 时长产想念候选,交决策 LLM/技能去重判沉默。
 * 情绪强度:有 `EmotionIntensityPort` 用其值(钳 [0,1]),否则用 config 默认(仅调语气,不改门槛)。
 */
export function idleArcCandidateSource(
  presence: PresencePort,
  clock: Clock,
  emotion?: EmotionIntensityPort,
  options?: Partial<IdleArcCandidateOptions>,
): ProactiveCandidateSource {
  const opts: IdleArcCandidateOptions = { ...DEFAULT_IDLE_ARC_CANDIDATE_OPTIONS, ...options };
  return {
    gather(): readonly string[] {
      const now = clock.now();
      const idleMs = Math.max(0, now - presence.lastUserActiveAtMs());
      if (idleMs < opts.missThresholdMs) return []; // idle 未达想念阈值,无情绪候选
      const intensity = Math.min(1, Math.max(0, emotion?.arcIntensity() ?? opts.defaultArcIntensity));
      const arc: IdleArc = 'miss';
      return [renderArcText(arc, intensity)];
    },
  };
}

/**
 * 合并多个候选源:依次 gather、拼接、去空白/去重(保序),返回合并候选。
 * 任一源抛错被隔离(优雅降级 §3.2):跳过该源、不中断其它源。
 */
export function combinedCandidateSource(
  sources: readonly ProactiveCandidateSource[],
): ProactiveCandidateSource {
  return {
    async gather(ctx: CandidateGatherContext): Promise<readonly string[]> {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const src of sources) {
        let got: readonly string[];
        try {
          got = await src.gather(ctx);
        } catch (err) {
          console.warn('[candidate-source] 某候选源 gather 抛错(已隔离,跳过):', err);
          continue;
        }
        for (const c of got) {
          const t = c.trim();
          if (t.length > 0 && !seen.has(t)) {
            seen.add(t);
            out.push(t);
          }
        }
      }
      return out;
    },
  };
}
