/**
 * idle 情绪弧 BaseSkill(standalone,承 canonical §7「idle 情绪弧 once-per-episode(想念/重逢)」)。
 *
 * 与 open-thread 跟进(话题导向)并列、互补的**情绪导向**主动技能:
 * - **想念**:用户长时间 idle(超过 `missThresholdMs`)→ 一次"想你了"的轻倾向意图;
 * - **重逢**:长缺席(idle 曾够久)后用户回来 → 一次"你回来啦"的问候。
 *
 * 决策遵循 §7 把**"是否值得说"作为一等决策** + **restraint-first**(克制优先):多数 tick 沉默;
 * 想念**每 idle episode 只一次**(以 `currentEpisodeId()` 去重),重逢**每被想念过的 episode 只一次**。
 * 只有真值得时才经 `requestSpeak()` 提交一条低优先级、可延续的意图(文案模板化)。
 *
 * 严格沿用包内既有接缝,**不另起一套节流**(与 `open-thread-skill.ts` 同范式):
 * - `enabled` 由 SkillScheduler **每 tick 现读 config** 决定(本技能不自查 enabled,合调度契约;
 *   默认在 config 侧关——承"autonomy 默认可关,P4 启用")。保留防御性早退。
 * - SkillScheduler 的 **per-skill inflight 锁**:`tick` 为 async,慢 tick 自动被锁跳过。
 * - **no-action 预算**(`budget.ts`):一 tick 没产出动作(沉默)→ `consumeOnNoAction` 扣 1 +
 *   合成"再想一次";预算耗尽则停止合成(不空转)。
 *
 * 情绪强度:若注入 `EmotionIntensityPort` 则用其 [0,1] 调制文案语气强度;否则回退 config 倾向常量
 * (`defaultArcIntensity`)。强度仅做语气调制,**不改变想念/重逢的触发门槛**(门槛由 idle 时长 + 去重定)。
 *
 * 可追溯(承 §8.1):每 tick 产出结构化 `IdleArcDecision`(为何想念/重逢/沉默)入环形日志。
 */
import { consumeOnNoAction, type BudgetState } from './budget';
import type { AutonomyConfig } from './config';
import type { EmotionIntensityPort, PresencePort } from './idle-emotion-arc';
import type { PriorityEventQueue } from './priority-queue';
import type { SpeakArbiter } from './open-thread-skill';
import type { BaseSkill } from './skill';
import type { Clock, EventPriority, SpeakOutcome, SpeakRequest } from './types';

/** 本技能的稳定 id(用于 enabled 现读、inflight 锁、追溯;单一权威常量)。 */
export const IDLE_EMOTION_ARC_SKILL_ID = 'idle-emotion-arc';

/**
 * idle 情绪弧的节流/决策旋钮(行为即配置,§3.2;无 magic number)。
 * 与 no-action 预算正交:这些管"idle 多久才算想念 / 缺席多久回来才值得重逢",预算管"沉默后是否再想"。
 */
export interface IdleEmotionArcOptions {
  /**
   * 想念阈值(毫秒):用户连续 idle 超过此时长 → 该 episode 允许一次想念。
   * restraint-first:取较保守的大阈值,避免稍一沉默就"打扰"。
   */
  readonly missThresholdMs: number;
  /**
   * 重逢阈值(毫秒):**上一段** idle 至少达此时长,用户回来后才值得一次重逢问候。
   * 短暂离开(如走神几秒)回来不触发重逢(避免每次小停顿都问候)。
   */
  readonly reunionThresholdMs: number;
  /** 提交发言的优先级(情绪弧属感知级主动,非紧急)。默认 PERCEPTION。 */
  readonly speakPriority: EventPriority;
  /**
   * 无情绪旋钮端口时的默认情绪强度倾向([0,1];仅调语气,不改门槛)。
   * 承"否则 config 倾向值"。
   */
  readonly defaultArcIntensity: number;
  /** 决策日志环形缓冲容量(可追溯;满则丢最旧)。 */
  readonly decisionLogCapacity: number;
}

/** 默认旋钮(克制优先的保守取值;可被构造覆盖)。 */
export const DEFAULT_IDLE_EMOTION_ARC_OPTIONS: IdleEmotionArcOptions = {
  missThresholdMs: 10 * 60 * 1000, // idle 超过 10min 才想念
  reunionThresholdMs: 10 * 60 * 1000, // 上段 idle 至少 10min,回来才重逢
  speakPriority: 'PERCEPTION',
  defaultArcIntensity: 0.5, // 中性强度
  decisionLogCapacity: 32,
};

/**
 * 一 tick 的结构化决策(承 §8.1 可追溯):
 * - `atMs`:决策时刻(注入时钟)。
 * - `action`:本 tick 最终动作——`speak`(提交想念/重逢且仲裁放行/延续)/ `silent`(沉默)/
 *   `disabled`(因 enabled=false 早退,理论上调度器已挡,留作防御)。
 * - `arc`:本 tick 触发的情绪弧种类(speak 时有:想念/重逢)。
 * - `episodeId`:相关 idle episode 标识(用于追溯去重;非沉默/非 disabled 时有)。
 * - `intensity`:本次采用的情绪强度([0,1];speak 时有)。
 * - `text`:实际提交的文案(沉默/disabled 时省)。
 * - `outcome`:仲裁裁决(speak 尝试时有)。
 * - `budgetConsumed`:本 tick 是否因无产出而扣了 no-action 预算。
 * - `reason`:本 tick 的总体理由(人类可读)。
 */
export type IdleArc = 'miss' | 'reunion';

export interface IdleArcDecision {
  readonly atMs: number;
  readonly action: 'speak' | 'silent' | 'disabled';
  readonly arc?: IdleArc;
  readonly episodeId?: string;
  readonly intensity?: number;
  readonly text?: string;
  readonly outcome?: SpeakOutcome;
  readonly budgetConsumed: boolean;
  readonly reason: string;
}

/** 构造依赖(全注入,standalone 可测;§3.1 依赖倒置 + §3.2 注入式时钟)。 */
export interface IdleEmotionArcDeps {
  readonly presence: PresencePort;
  readonly arbiter: SpeakArbiter;
  readonly clock: Clock;
  readonly config: AutonomyConfig;
  /** no-action 预算可变状态(由 autonomy 引擎/调度回路持有并传入)。 */
  readonly budget: BudgetState;
  /** 预算合成"再想一次"事件要入的队列。 */
  readonly queue: PriorityEventQueue;
  /** 情绪强度旋钮端口(可选;省略则用 config `defaultArcIntensity`)。 */
  readonly emotion?: EmotionIntensityPort;
  /** 决策旋钮覆盖(可选;省略键用默认,exactOptionalPropertyTypes 友好)。 */
  readonly options?: Partial<IdleEmotionArcOptions>;
}

/**
 * idle 情绪弧技能。`tick` 流程:读在场感 → 决策(restraint-first + once-per-episode)→ requestSpeak / 沉默。
 * 自身不查 enabled(SkillScheduler 现读 config 后才会调本 tick),但保留防御性早退。
 *
 * once-per-episode 去重实现(纯内存,确定性):
 * - 跟踪"上一次见到的 episodeId"(`#prevEpisodeId`)与"是否在该 episode 内想念过"(`#missedEpisodeId`)。
 * - episodeId 变化即视为用户回来开启新 episode:若旧 episode 的 idle 曾够长(被想念过 / 上段 idle 达重逢阈值)
 *   → 本新 episode 允许一次重逢。
 */
export class IdleEmotionArcSkill implements BaseSkill {
  readonly id = IDLE_EMOTION_ARC_SKILL_ID;

  readonly #presence: PresencePort;
  readonly #arbiter: SpeakArbiter;
  readonly #clock: Clock;
  readonly #config: AutonomyConfig;
  readonly #budget: BudgetState;
  readonly #queue: PriorityEventQueue;
  readonly #emotion: EmotionIntensityPort | undefined;
  readonly #options: IdleEmotionArcOptions;

  /** 上一 tick 见到的 episodeId(检测 episode 轮转 = 用户回来)。 */
  #prevEpisodeId: string | undefined;
  /** 上一 tick 该 episode 的 idle 时长(episode 轮转时据此判定重逢是否够长)。 */
  #prevIdleMs = 0;
  /** 已想念过的 episodeId(想念 once-per-episode 去重)。 */
  #missedEpisodeId: string | undefined;
  /** 已重逢问候过的 episodeId(重逢 once-per-episode 去重)。 */
  #reunionedEpisodeId: string | undefined;
  /** 标记:新 episode 是否"待重逢"(上段 idle 够长,本 episode 应问候一次)。 */
  #pendingReunionForEpisodeId: string | undefined;
  /** 决策日志环形缓冲(可追溯)。 */
  #decisions: IdleArcDecision[] = [];

  constructor(deps: IdleEmotionArcDeps) {
    this.#presence = deps.presence;
    this.#arbiter = deps.arbiter;
    this.#clock = deps.clock;
    this.#config = deps.config;
    this.#budget = deps.budget;
    this.#queue = deps.queue;
    this.#emotion = deps.emotion;
    this.#options = { ...DEFAULT_IDLE_EMOTION_ARC_OPTIONS, ...deps.options };
  }

  /** 最近若干条决策的只读快照(追溯用,出队序为时间序)。 */
  get decisions(): readonly IdleArcDecision[] {
    return this.#decisions;
  }

  /** 最近一条决策(测试/追溯便捷)。 */
  get lastDecision(): IdleArcDecision | undefined {
    return this.#decisions[this.#decisions.length - 1];
  }

  /**
   * 一个调度 tick:读在场感 → 决策 → requestSpeak / 沉默。
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
      });
      return;
    }

    // 1. 读在场感:当前 episode 标识 + 用户上次活跃时刻 → 当前 idle 时长。
    const episodeId = this.#presence.currentEpisodeId();
    const idleMs = Math.max(0, now - this.#presence.lastUserActiveAtMs());

    // 2. episode 轮转检测(用户回来):episodeId 变了 → 据旧 episode 是否够长安排"待重逢"。
    this.#detectEpisodeRollover(episodeId);

    // 3a. 重逢优先(用户刚回来,先打招呼再谈想念):本 episode 待重逢且未问候过 → 提交一次重逢。
    if (
      this.#pendingReunionForEpisodeId === episodeId &&
      this.#reunionedEpisodeId !== episodeId
    ) {
      const spoke = this.#trySpeak('reunion', episodeId, now);
      if (spoke) {
        this.#reunionedEpisodeId = episodeId;
        this.#pendingReunionForEpisodeId = undefined;
      }
      // trySpeak 内部已记决策 + 处理预算(drop 视同无产出);无论成败本 tick 到此结束。
      this.#rememberTick(episodeId, idleMs);
      return;
    }

    // 3b. 想念:idle 超阈值且本 episode 未想念过 → 提交一次想念。
    const overMissThreshold = idleMs >= this.#options.missThresholdMs;
    if (overMissThreshold && this.#missedEpisodeId !== episodeId) {
      const spoke = this.#trySpeak('miss', episodeId, now);
      if (spoke) {
        this.#missedEpisodeId = episodeId;
      }
      this.#rememberTick(episodeId, idleMs);
      return;
    }

    // 3c. 其余 → 沉默 + 扣 no-action 预算(承 §7)。
    const consumed = consumeOnNoAction(this.#budget, this.#queue, this.#clock);
    this.#log({
      atMs: now,
      action: 'silent',
      episodeId,
      budgetConsumed: consumed,
      reason: this.#silentReason(episodeId, idleMs, overMissThreshold),
    });
    this.#rememberTick(episodeId, idleMs);
  }

  /**
   * 检测 episode 轮转(用户从沉默回到活跃):
   * - 首见某 episode 时仅记录,不算轮转。
   * - episodeId 由旧变新 → 用户回来:若**上一段 idle**曾达重逢阈值(或在旧 episode 想念过)
   *   → 把新 episode 标记为"待重逢"(本 episode 应问候一次)。
   */
  #detectEpisodeRollover(episodeId: string): void {
    if (this.#prevEpisodeId === undefined || this.#prevEpisodeId === episodeId) {
      return; // 首见或同一 episode:无轮转。
    }
    const prevWasLongAbsence =
      this.#prevIdleMs >= this.#options.reunionThresholdMs ||
      this.#missedEpisodeId === this.#prevEpisodeId;
    if (prevWasLongAbsence) {
      this.#pendingReunionForEpisodeId = episodeId;
    }
  }

  /**
   * 尝试经 requestSpeak 提交一次情绪弧发言:
   * - 模板化文案(主语中性"你";情绪强度来自旋钮端口或 config 默认)。
   * - speak/defer 视为已产出动作(记 speak 决策、不扣预算)→ 返回 true(供调用方记去重)。
   * - drop(忙且不可延续)视同无产出 → 沉默 + 扣预算 → 返回 false(不记去重,留待下次)。
   */
  #trySpeak(arc: IdleArc, episodeId: string, now: number): boolean {
    const intensity = this.#resolveIntensity();
    const text = renderArcText(arc, intensity);
    const request: SpeakRequest = {
      skillId: this.id,
      priority: this.#options.speakPriority,
      deferrable: true, // 情绪弧非紧急,忙时可记 history 待续而非丢弃
      text,
    };
    const outcome = this.#arbiter.requestSpeak(request);

    if (outcome.decision === 'drop') {
      const consumed = consumeOnNoAction(this.#budget, this.#queue, this.#clock);
      this.#log({
        atMs: now,
        action: 'silent',
        arc,
        episodeId,
        intensity,
        budgetConsumed: consumed,
        outcome,
        reason: `silent: 想${arc === 'miss' ? '念' : '重逢'}但仲裁 drop(${outcome.reason}),留待下次`,
      });
      return false;
    }

    this.#log({
      atMs: now,
      action: 'speak',
      arc,
      episodeId,
      intensity,
      text,
      outcome,
      budgetConsumed: false,
      reason: `speak: ${arc === 'miss' ? '长 idle → 想念' : '长缺席后回来 → 重逢'}(${outcome.decision};${outcome.reason})`,
    });
    return true;
  }

  /** 解析本次情绪强度:有旋钮端口用其值(钳到 [0,1]),否则用 config 默认倾向。 */
  #resolveIntensity(): number {
    const raw = this.#emotion?.arcIntensity() ?? this.#options.defaultArcIntensity;
    return Math.min(1, Math.max(0, raw));
  }

  /** 组织沉默理由(可追溯:为何这 tick 不开口)。 */
  #silentReason(episodeId: string, idleMs: number, overMissThreshold: boolean): string {
    if (!overMissThreshold) {
      return 'silent: idle 未达想念阈值,克制不开口';
    }
    if (this.#missedEpisodeId === episodeId) {
      return 'silent: 本 episode 已想念过(once-per-episode),不重复';
    }
    return `silent: idle ${idleMs}ms 已达阈值但无可触发弧,克制`;
  }

  /** tick 收尾:记下本 tick 见到的 episode 与 idle 时长(供下一 tick 检测轮转)。 */
  #rememberTick(episodeId: string, idleMs: number): void {
    this.#prevEpisodeId = episodeId;
    this.#prevIdleMs = idleMs;
  }

  /** 追加一条决策到环形缓冲(满则丢最旧)。 */
  #log(decision: IdleArcDecision): void {
    this.#decisions.push(decision);
    if (this.#decisions.length > this.#options.decisionLogCapacity) {
      this.#decisions = this.#decisions.slice(
        this.#decisions.length - this.#options.decisionLogCapacity,
      );
    }
  }
}

/**
 * 模板化情绪弧文案(主语中性"你";情绪强度调制语气浓淡):
 * - `miss`(想念):强度高 → 更直白的想念;强度低 → 轻描淡写的关切。
 * - `reunion`(重逢):强度高 → 热情迎接;强度低 → 平和问候。
 * 真实现以后可由人格/PAD 渲染更丰富文案;本切片给确定性模板(利 golden test)。
 */
export function renderArcText(arc: IdleArc, intensity: number): string {
  const warm = intensity >= 0.5;
  if (arc === 'miss') {
    return warm ? '好久没听到你说话了,有点想你。' : '在忙吗?随时来找我聊。';
  }
  return warm ? '你回来啦!我一直在等你。' : '嗨,你回来了。';
}
