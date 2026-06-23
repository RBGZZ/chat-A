/**
 * open-thread 主动跟进 BaseSkill(standalone,承 canonical §7#2 + §7 autonomy 框架)。
 *
 * 每 tick:`gather → 决策 → requestSpeak`。决策遵循 §7 把**"是否值得说"作为一等决策** +
 * **restraint-first**(克制优先):综合"线索新鲜度 / 是否到 due / 距上次跟进间隔 / cadence /
 * no-action 预算",**多数 tick 选择沉默**;只有真值得时才经 `requestSpeak()` 提交一条跟进意图
 * (文案模板化,主语用 person)。
 *
 * 沿用包内既有接缝,**不另起一套节流**:
 * - `enabled` 由 SkillScheduler **每 tick 现读 config** 决定(本技能不自查 enabled,合调度契约);
 *   构造时 `enabled` 默认在 config 侧关(承"autonomy 默认可关,P4 启用")。
 * - SkillScheduler 的 **per-skill inflight 锁**:本技能 `tick` 是 async,慢 tick 自动被锁跳过。
 * - **no-action 预算**(`budget.ts`):一 tick 没产出动作(沉默)→ `consumeOnNoAction` 扣 1 +
 *   合成"再想一次";预算耗尽则停止合成(不空转)。
 *
 * 可追溯(承 §8.1 autonomy 决策可追溯):每 tick 产出结构化 `FollowUpDecision`(为何跟进/为何沉默),
 * 留存于 `decisions` 环形日志,供上层(接线层 trace/日志)读取。本切片无包内日志接缝,故以结构化
 * 返回 + 内部环形缓冲承载,不引外部依赖(standalone)。
 */
import { consumeOnNoAction, type BudgetState } from './budget';
import type { AutonomyConfig } from './config';
import type { OpenThread, OpenThreadPort } from './open-thread';
import type { PriorityEventQueue } from './priority-queue';
import type { BaseSkill } from './skill';
import type { Clock, EventPriority, SpeakOutcome, SpeakRequest } from './types';

/** 本技能的稳定 id(用于 enabled 现读、inflight 锁、追溯;单一权威常量)。 */
export const OPEN_THREAD_FOLLOWUP_SKILL_ID = 'open-thread-followup';

/**
 * requestSpeak 仲裁接缝(承 §7 统一输出仲裁器):技能"想说"经此提交,得到三态裁决。
 * 注入而非直接 import `arbitrate`,以便:① 调用方注入"读当前 is_speaking 后再仲裁"的闭包;
 * ② 测试用假实现观测/构造裁决。真实现以后由接线层包 `arbitrate(req, 当前 SpeakState)`。
 */
export interface SpeakArbiter {
  requestSpeak(request: SpeakRequest): SpeakOutcome;
}

/**
 * open-thread 跟进技能的节流/决策旋钮(行为即配置,§3.2;无 magic number)。
 * 与 no-action 预算正交:这些管"何时一条话题才值得跟进",预算管"沉默后是否再想"。
 */
export interface OpenThreadFollowUpOptions {
  /**
   * 同一话题两次跟进的最小间隔(毫秒):上次跟进它后,未过此间隔则不再跟进(per-thread cadence)。
   * restraint-first 的核心节流:避免反复追问同一件事。
   */
  readonly perThreadCooldownMs: number;
  /**
   * 跨话题的全局 cadence(毫秒):本技能任意两次成功跟进的最小间隔,避免一口气连珠炮。
   */
  readonly globalCadenceMs: number;
  /**
   * 线索"陈旧"上限(毫秒):距用户上次提及超过此时长的话题视为已凉、不主动翻旧账
   * (除非到 due)。承 restraint-first:不无端翻很久以前的事。
   */
  readonly staleAfterMs: number;
  /**
   * 线索"太新"下限(毫秒):距上次提及还不到此时长的话题视为话音未落、不急着跟进
   * (除非到 due)。避免用户刚说完就追问。
   */
  readonly minFreshnessMs: number;
  /** 提交发言的优先级(open-thread 跟进属感知级主动,非紧急)。默认 PERCEPTION。 */
  readonly speakPriority: EventPriority;
  /** 决策日志环形缓冲容量(可追溯;满则丢最旧)。 */
  readonly decisionLogCapacity: number;
}

/** 默认旋钮(克制优先的保守取值;可被构造覆盖)。 */
export const DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS: OpenThreadFollowUpOptions = {
  perThreadCooldownMs: 12 * 60 * 60 * 1000, // 同一话题 12h 内不重复追问
  globalCadenceMs: 30 * 60 * 1000, // 任意两次跟进至少隔 30min
  staleAfterMs: 7 * 24 * 60 * 60 * 1000, // 超过 7 天没提的旧事不主动翻(除非到 due)
  minFreshnessMs: 60 * 60 * 1000, // 提起不到 1h 的事不急着追问(除非到 due)
  speakPriority: 'PERCEPTION',
  decisionLogCapacity: 32,
};

/** 单条话题在一 tick 内的取舍结果(可追溯:为何选它 / 为何跳过它)。 */
export type ThreadVerdict =
  | { readonly kind: 'follow-up'; readonly threadId: string; readonly reason: string }
  | { readonly kind: 'skip'; readonly threadId: string; readonly reason: string };

/**
 * 一 tick 的结构化决策(承 §8.1 可追溯):
 * - `atMs`:决策时刻(注入时钟)。
 * - `action`:本 tick 最终动作——`speak`(提交跟进且仲裁放行/延续)/ `silent`(沉默)/
 *   `disabled`(因 enabled=false 早退,理论上不会发生,调度器已挡,留作防御)。
 * - `chosenThreadId`:被选中跟进的话题 id(沉默时省)。
 * - `text`:实际提交的文案(沉默时省)。
 * - `outcome`:仲裁裁决(speak 时有)。
 * - `budgetConsumed`:本 tick 是否因无产出而扣了 no-action 预算。
 * - `reason`:本 tick 的总体理由(人类可读)。
 * - `verdicts`:逐条话题的取舍明细(调试/追溯)。
 */
export interface FollowUpDecision {
  readonly atMs: number;
  readonly action: 'speak' | 'silent' | 'disabled';
  readonly chosenThreadId?: string;
  readonly text?: string;
  readonly outcome?: SpeakOutcome;
  readonly budgetConsumed: boolean;
  readonly reason: string;
  readonly verdicts: readonly ThreadVerdict[];
}

/** 构造依赖(全注入,standalone 可测;§3.1 依赖倒置 + §3.2 注入式时钟)。 */
export interface OpenThreadFollowUpDeps {
  readonly port: OpenThreadPort;
  readonly arbiter: SpeakArbiter;
  readonly clock: Clock;
  readonly config: AutonomyConfig;
  /** no-action 预算可变状态(由 autonomy 引擎/调度回路持有并传入)。 */
  readonly budget: BudgetState;
  /** 预算合成"再想一次"事件要入的队列。 */
  readonly queue: PriorityEventQueue;
  /** 决策旋钮覆盖(可选;省略键用默认,exactOptionalPropertyTypes 友好)。 */
  readonly options?: Partial<OpenThreadFollowUpOptions>;
}

/**
 * open-thread 主动跟进技能。`tick` 流程:gather → 决策(restraint-first)→ requestSpeak / 沉默。
 * 自身不查 enabled(SkillScheduler 现读 config 后才会调本 tick),但保留防御性早退。
 */
export class OpenThreadFollowUpSkill implements BaseSkill {
  readonly id = OPEN_THREAD_FOLLOWUP_SKILL_ID;

  readonly #port: OpenThreadPort;
  readonly #arbiter: SpeakArbiter;
  readonly #clock: Clock;
  readonly #config: AutonomyConfig;
  readonly #budget: BudgetState;
  readonly #queue: PriorityEventQueue;
  readonly #options: OpenThreadFollowUpOptions;

  /** per-thread 上次成功跟进时刻(cadence 现读依据)。 */
  readonly #lastFollowUpAtByThread = new Map<string, number>();
  /** 全局上次成功跟进时刻(跨话题 cadence)。 */
  #lastGlobalFollowUpAtMs: number | undefined;
  /** 决策日志环形缓冲(可追溯)。 */
  #decisions: FollowUpDecision[] = [];

  constructor(deps: OpenThreadFollowUpDeps) {
    this.#port = deps.port;
    this.#arbiter = deps.arbiter;
    this.#clock = deps.clock;
    this.#config = deps.config;
    this.#budget = deps.budget;
    this.#queue = deps.queue;
    this.#options = { ...DEFAULT_OPEN_THREAD_FOLLOWUP_OPTIONS, ...deps.options };
  }

  /** 最近若干条决策的只读快照(追溯用,出队序为时间序)。 */
  get decisions(): readonly FollowUpDecision[] {
    return this.#decisions;
  }

  /** 最近一条决策(测试/追溯便捷)。 */
  get lastDecision(): FollowUpDecision | undefined {
    return this.#decisions[this.#decisions.length - 1];
  }

  /**
   * 一个调度 tick:gather → 决策 → requestSpeak / 沉默。
   * 防御性早退:若 config 现读本技能为 disabled(正常不会发生,调度器已挡)→ 记 disabled 决策即返回,
   * 且**不扣预算**(没启用就谈不上"无产出")。
   */
  async tick(): Promise<void> {
    const now = this.#clock.now();

    if (!this.#config.isEnabled(this.id)) {
      this.#log({
        atMs: now,
        action: 'disabled',
        budgetConsumed: false,
        reason: 'disabled: config 现读本技能未启用,跳过(防御)',
        verdicts: [],
      });
      return;
    }

    // 1. gather:读候选未了话题。
    const threads = await this.#port.listOpenThreads();

    // 2. 决策:逐条判定,挑出"最值得"的一条(restraint-first,多数 tick 选不出)。
    const verdicts: ThreadVerdict[] = [];
    let best: { thread: OpenThread; score: number } | undefined;

    const globalCoolingDown =
      this.#lastGlobalFollowUpAtMs !== undefined &&
      now - this.#lastGlobalFollowUpAtMs < this.#options.globalCadenceMs;

    for (const thread of threads) {
      const verdict = this.#judge(thread, now, globalCoolingDown);
      verdicts.push(verdict);
      if (verdict.kind === 'follow-up') {
        const score = this.#score(thread, now);
        if (best === undefined || score > best.score) {
          best = { thread, score };
        }
      }
    }

    // 3a. 没有任何值得跟进的话题 → 沉默 + 扣 no-action 预算(承 §7)。
    if (best === undefined) {
      const consumed = consumeOnNoAction(this.#budget, this.#queue, this.#clock);
      this.#log({
        atMs: now,
        action: 'silent',
        budgetConsumed: consumed,
        reason: globalCoolingDown
          ? 'silent: 全局 cadence 冷却中,本 tick 一律克制'
          : 'silent: 无到期/新鲜且未冷却的未了话题,克制不开口',
        verdicts,
      });
      return;
    }

    // 3b. 有值得跟进的话题 → 模板化文案 + 经 requestSpeak 仲裁提交。
    const text = renderFollowUpText(best.thread);
    const request: SpeakRequest = {
      skillId: this.id,
      priority: this.#options.speakPriority,
      deferrable: true, // 跟进非紧急,忙时可记 history 待续而非丢弃
      text,
    };
    const outcome = this.#arbiter.requestSpeak(request);

    if (outcome.decision === 'drop') {
      // 仲裁丢弃(忙且不可延续)→ 视同无产出:沉默 + 扣预算。
      const consumed = consumeOnNoAction(this.#budget, this.#queue, this.#clock);
      this.#log({
        atMs: now,
        action: 'silent',
        chosenThreadId: best.thread.id,
        budgetConsumed: consumed,
        outcome,
        reason: `silent: 选中话题「${best.thread.topic}」但仲裁 drop(${outcome.reason})`,
        verdicts,
      });
      return;
    }

    // speak / defer 均视为"已产出动作":记 cadence、不扣预算。
    this.#lastFollowUpAtByThread.set(best.thread.id, now);
    this.#lastGlobalFollowUpAtMs = now;
    this.#log({
      atMs: now,
      action: 'speak',
      chosenThreadId: best.thread.id,
      text,
      outcome,
      budgetConsumed: false,
      reason: `speak: 跟进话题「${best.thread.topic}」(${outcome.decision};${outcome.reason})`,
      verdicts,
    });
  }

  /**
   * 单条话题取舍(restraint-first):
   * - 到 due(`dueAtMs` 已过)→ 强信号,只要不在 per-thread 冷却就跟进。
   * - 未到 due:要求新鲜度落在 [minFreshness, staleAfter] 窗口内(太新不急、太旧不翻)。
   * - per-thread 冷却中(上次跟进它未过 cooldown)→ 跳过。
   * - 全局 cadence 冷却中 → 一律跳过(克制)。
   */
  #judge(thread: OpenThread, now: number, globalCoolingDown: boolean): ThreadVerdict {
    if (globalCoolingDown) {
      return { kind: 'skip', threadId: thread.id, reason: 'skip: 全局 cadence 冷却中' };
    }

    const lastFollowUp = this.#lastFollowUpAtByThread.get(thread.id);
    if (lastFollowUp !== undefined && now - lastFollowUp < this.#options.perThreadCooldownMs) {
      return { kind: 'skip', threadId: thread.id, reason: 'skip: 该话题 per-thread 冷却中,不重复追问' };
    }

    const isDue = thread.dueAtMs !== undefined && now >= thread.dueAtMs;
    if (isDue) {
      return { kind: 'follow-up', threadId: thread.id, reason: 'follow-up: 已到 due,该问了' };
    }

    const sinceMention = now - thread.lastMentionedAtMs;
    if (sinceMention < this.#options.minFreshnessMs) {
      return { kind: 'skip', threadId: thread.id, reason: 'skip: 话音未落(太新),不急着追问' };
    }
    if (sinceMention > this.#options.staleAfterMs) {
      return { kind: 'skip', threadId: thread.id, reason: 'skip: 线索已凉(太旧),不主动翻旧账' };
    }
    return {
      kind: 'follow-up',
      threadId: thread.id,
      reason: 'follow-up: 新鲜度落在窗口内,值得自然回扣',
    };
  }

  /**
   * 打分挑"最值得"的一条(仅在候选间排序,不改变"是否值得说"的门槛):
   * 到 due 的优先(加大基线),其次越接近 due / 越新鲜越靠前。分值仅用于同 tick 内择优。
   */
  #score(thread: OpenThread, now: number): number {
    let score = 0;
    if (thread.dueAtMs !== undefined && now >= thread.dueAtMs) {
      // 到 due:基线很高,且过 due 越久越急(轻微加权)。
      score += 1_000_000 + (now - thread.dueAtMs);
    } else {
      // 未到 due:越新鲜(距上次提及越短)越靠前。
      score += Math.max(0, this.#options.staleAfterMs - (now - thread.lastMentionedAtMs));
    }
    return score;
  }

  /** 追加一条决策到环形缓冲(满则丢最旧)。 */
  #log(decision: FollowUpDecision): void {
    this.#decisions.push(decision);
    if (this.#decisions.length > this.#options.decisionLogCapacity) {
      this.#decisions = this.#decisions.slice(this.#decisions.length - this.#options.decisionLogCapacity);
    }
  }
}

/**
 * 模板化跟进文案(主语用 person,承 §5.3 记忆带主语):
 * 有花名册名 → 直接对话主体("你昨天说要面试,今天怎么样?");
 * 仅 personId → 仍可渲染但用中性"你"(接线层通常已带 personName)。
 */
export function renderFollowUpText(thread: OpenThread): string {
  const who = thread.personName ?? '你';
  return `${who},之前说到「${thread.topic}」,后来怎么样了?`;
}
