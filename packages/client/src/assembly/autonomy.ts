/**
 * autonomy 主动引擎装配薄壳(runtime-assembly-wiring,承 §7 / §8.1 / §3.1)。
 *
 * 把 {@link ProactiveTurnRunner} 包进一个 {@link AutonomyRunnerSkill}(`BaseSkill`),挂上
 * {@link SkillScheduler} + 真 {@link LightVoiceBus}(`onAny` → `ingestBusEventAsSignal` 把总线
 * `signal:*` 入优先级队列)+ 注入的 `AutonomyDecisionSink`(接线层提供 SQLite 实现,§8.1)。
 *
 * **默认关**:仅 `CHAT_A_AUTONOMY=on`(经既有 {@link isAutonomyEnabled})才装配;缺省 = off →
 * 返回 `undefined`(不挂调度、不订阅总线、不构造决策 LLM → VoiceLoop 与总线行为逐字不变)。
 *
 * standalone 解耦(§3.1):出声经注入的 `requestSpeak` 闭包(包 `arbitrate`),**不 import
 * runtime/VoiceLoop 内部**;MVP 的 `is_speaking` 硬闸用一个保守缺省状态(真抢占执行属
 * autonomy-runtime-wiring 的 runtime 改动范围,本装配层不重做,只产信号)。
 */
import { stdout } from 'node:process';
import type { LightVoiceBus, SpeakStateView } from '@chat-a/runtime';
import type { LlmProvider } from '@chat-a/providers';
import {
  DecisionLlm,
  ProactiveTurnRunner,
  PriorityEventQueue,
  SkillScheduler,
  arbitrate,
  enabledSetConfig,
  ingestBusEventAsSignal,
  isAutonomyEnabled,
  systemClock,
  type AutonomyDecisionSink,
  type BaseSkill,
  type Clock,
  type ProactiveCandidateSource,
  type SpeakArbiter,
  type SpeakOutcome,
  type SpeakRequest,
  type SpeakState,
} from '@chat-a/autonomy';

/** 本装配挂的主动技能 id(稳定常量,用于 enabled 现读 / inflight 锁 / 追溯)。 */
export const AUTONOMY_RUNNER_SKILL_ID = 'autonomy-runner';

/** autonomy tick 默认周期(ms):主动决策非热路径,低频(无 magic number)。 */
export const DEFAULT_AUTONOMY_TICK_MS = 5_000;

/** 解析 autonomy tick 周期:`CHAT_A_AUTONOMY_TICK_MS`,非法/缺省回落默认(>0 整数)。 */
export function loadAutonomyTickMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env['CHAT_A_AUTONOMY_TICK_MS'] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_AUTONOMY_TICK_MS;
}

/** 每日主动开口上限缺省(§11 调参):缺省 3 次/天。 */
export const DEFAULT_AUTONOMY_DAILY_CAP = 3;

/**
 * 解析每日主动开口上限:`CHAT_A_AUTONOMY_DAILY_CAP`,合法整数且 ≥0 用之(0/负=不限),
 * 非法/缺省回落默认 3。
 */
export function loadAutonomyDailyCap(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env['CHAT_A_AUTONOMY_DAILY_CAP'] ?? '', 10);
  return Number.isInteger(raw) && raw >= 0 ? raw : DEFAULT_AUTONOMY_DAILY_CAP;
}

/**
 * 把 {@link ProactiveTurnRunner} 包成一个后台技能:每 tick 从队列取一条 signal,
 * 据其组织候选 + context 跑一次主动回合。
 *
 * **缝 3(真候选)**:注入 `candidateSource` 时优先用其产出的**真实候选**(基于记忆未了话题/情绪弧)
 * 喂决策 LLM;无源 / 源本 tick 返回空时回落现状占位(signal 描述 / kind)。决策 LLM schema 约束 +
 * 失败退 silent + 落 trace 全不变(候选只是喂料,restraint-first 不被削弱)。
 *
 * **缝 1(真抢占)**:`shouldPreempt` 时回调 `onPreempt`(装配缺省回落为触发 VoiceLoop 真打断)。
 */
export class AutonomyRunnerSkill implements BaseSkill {
  readonly id = AUTONOMY_RUNNER_SKILL_ID;
  readonly #runner: ProactiveTurnRunner;
  readonly #queue: PriorityEventQueue;
  readonly #onPreempt: ((outcome: SpeakOutcome) => void) | undefined;
  readonly #candidateSource: ProactiveCandidateSource | undefined;
  readonly #onProactiveSpeak: ((speech: ProactiveSpeech) => void) | undefined;

  constructor(deps: {
    readonly runner: ProactiveTurnRunner;
    readonly queue: PriorityEventQueue;
    readonly onPreempt?: (outcome: SpeakOutcome) => void;
    /** 缝 3:真候选源(open-thread / idle-arc;无则回落现状占位)。 */
    readonly candidateSource?: ProactiveCandidateSource;
    /**
     * 主动消息推送钩子(代理B):仲裁判定真说(`outcome.decision==='speak'`)时,
     * 把决策 LLM 产出的**真实主动话语**经此回调推出去(desktop 据此渲染自发气泡)。
     * 与 `onPreempt`(只产抢占信号)正交:本钩子产「说什么」,onPreempt 产「要不要打断」。
     */
    readonly onProactiveSpeak?: (speech: ProactiveSpeech) => void;
  }) {
    this.#runner = deps.runner;
    this.#queue = deps.queue;
    this.#onPreempt = deps.onPreempt;
    this.#candidateSource = deps.candidateSource;
    this.#onProactiveSpeak = deps.onProactiveSpeak;
  }

  async tick(): Promise<void> {
    const event = this.#queue.dequeue();
    if (event === undefined) return; // 队列空:本 tick 无事可做。
    // 现状占位:用 signal 的描述当线索(回落用)。
    const description =
      typeof (event.payload as { description?: unknown } | undefined)?.description === 'string'
        ? (event.payload as { description: string }).description
        : event.kind;

    // 缝 3:优先真候选源(失败/空回落占位,§3.2 优雅降级)。
    let candidates: readonly string[] = [description];
    if (this.#candidateSource !== undefined) {
      try {
        const real = await this.#candidateSource.gather({
          signalKind: event.kind,
          ...(typeof description === 'string' ? { description } : {}),
        });
        if (real.length > 0) candidates = real;
      } catch {
        /* 候选源失败:回落占位候选,不中断决策回路(§3.2) */
      }
    }

    const result = await this.#runner.run({
      skillId: this.id,
      candidates,
      context: `感知信号: ${event.kind}`,
      priority: event.priority,
      deferrable: true,
    });
    // 主动消息推送(代理B):仲裁真说才推(decision==='speak');带上 trace 文本与信号来源,
    // desktop 据此渲染一条自发的小雪气泡。决策已 silent/defer/drop 则不推(克制优先,绝不刷屏)。
    if (
      result.outcome?.decision === 'speak' &&
      result.decision.text !== undefined &&
      result.decision.text.trim().length > 0
    ) {
      this.#onProactiveSpeak?.({
        text: result.decision.text,
        signalKind: event.kind,
        preempted: result.shouldPreempt,
      });
    }
    if (result.shouldPreempt && result.outcome) {
      this.#onPreempt?.(result.outcome);
    }
  }
}

/** 一条主动话语(代理B):决策 LLM 产出、经仲裁真说,推给上层渲染/旁路。 */
export interface ProactiveSpeech {
  /** 经 persona guardrail 后的真实主动话语(非空)。 */
  readonly text: string;
  /** 触发本次主动回合的感知信号 kind(便于追溯/UI 标注)。 */
  readonly signalKind: string;
  /** 本次真说是否伴随抢占(打断在说者);UI 可据此微调标记。 */
  readonly preempted: boolean;
}

/** autonomy 装配运行句柄:`tick` 推一拍调度;`stop` 收尾(停定时器 + 退订总线)。 */
export interface AutonomyHandle {
  readonly skillId: string;
  readonly tickMs: number;
  /** 推一次 scheduler tick(测试可手动驱动,确定性)。 */
  tick(): Promise<void>;
  stop(): void;
}

export interface AssembleAutonomyDeps {
  readonly bus: LightVoiceBus;
  readonly llm: LlmProvider;
  /** 决策 trace sink(接线层提供 SQLite 实现;缺省由 DecisionLlm 内部回落 Noop)。 */
  readonly decisionSink?: AutonomyDecisionSink;
  /** 注入时钟(确定性测试);缺省 systemClock。 */
  readonly clock?: Clock;
  /** 注入定时器(确定性测试);缺省 setInterval。返回取消句柄。 */
  readonly schedule?: (fn: () => void, periodMs: number) => () => void;
  /** is_speaking 硬闸读取(缺省「未在说」;优先用 {@link voiceState})。 */
  readonly currentSpeakState?: () => SpeakState;
  /**
   * 缝 2:VoiceLoop 真实忙闲读取(传 `() => voiceLoop.speakState()`)。
   * 优先级高于 `currentSpeakState`;`SpeakStateView` 与 autonomy `SpeakState` 结构等价,直接透传。
   * 经此接缝 arbiter 才查到 VoiceLoop 真在说,而非保守缺省。**不 import VoiceLoop 内部**(§3.1)。
   */
  readonly voiceState?: () => SpeakStateView;
  /** 抢占信号回调(优先;不传则缺省回落 {@link preempt} 触发 VoiceLoop 真打断)。 */
  readonly onPreempt?: (outcome: SpeakOutcome) => void;
  /**
   * 缝 1:VoiceLoop 真打断触发(传 `(reason) => voiceLoop.requestAutonomyPreempt(reason)`)。
   * `onPreempt` 未传时,`shouldPreempt` 经此触发既有 abort 三件套(受 §7 attention + is_speaking 约束;
   * 绝不凌驾用户语音 URGENT)。off 路径不构造,未注入则退回「仅记录」。
   */
  readonly preempt?: (reason?: string) => void;
  /** 缝 3:真候选源(open-thread / idle-arc;无则技能回落现状占位)。 */
  readonly candidateSource?: ProactiveCandidateSource;
  /** 决策概率闸的 rng(确定性测试可注入恒过/恒拒);缺省 Math.random(restraint-first)。 */
  readonly decisionRng?: () => number;
  /**
   * 主动消息推送钩子(代理B):仲裁真说时把主动话语经此推出(desktop 主进程传
   * `(s) => emit(IPC.proactiveMessage, ...)`)。不传则不推(等价现状,只走 trace/抢占)。
   */
  readonly onProactiveSpeak?: (speech: ProactiveSpeech) => void;
  /**
   * 决策 LLM 的 system 提示(代理B):注入则覆盖 DecisionLlm 内置「多数沉默」提示——
   * 装配层可传**人格/记忆感知**提示(如以 `composeOmniInstructions()` 为底),
   * 让主动话语真走人格/记忆而非硬编码。不传则与现状逐字一致。
   */
  readonly decisionSystemPrompt?: string;
}

/**
 * 按开关装配 autonomy。off(`CHAT_A_AUTONOMY` ≠ on)→ undefined(不挂任何东西)。
 * on → 建 queue / DecisionLlm / runner / arbiter 闭包 / 技能 / scheduler,订阅总线 `signal:*`,
 * 返回 `{ tick, stop }`。tick 由内部定时器或外部(测试)驱动。
 */
export function assembleAutonomy(
  env: NodeJS.ProcessEnv,
  deps: AssembleAutonomyDeps,
): AutonomyHandle | undefined {
  if (!isAutonomyEnabled(env)) return undefined;

  const clock = deps.clock ?? systemClock;
  const tickMs = loadAutonomyTickMs(env);
  const queue = new PriorityEventQueue();

  // 决策 LLM(失败/超时退 silent;决策落注入 sink)。
  // 代理B:可注入 persona/记忆感知的决策 system 提示(默认走 DecisionLlm 内置「多数沉默」提示),
  // 使主动话语真正经人格/记忆生成而非硬编码。
  const decisionLlm = new DecisionLlm({
    llm: deps.llm,
    clock,
    dailyCap: loadAutonomyDailyCap(env),
    ...(deps.decisionSink ? { sink: deps.decisionSink } : {}),
    ...(deps.decisionRng ? { rng: deps.decisionRng } : {}),
    ...(deps.decisionSystemPrompt ? { systemPrompt: deps.decisionSystemPrompt } : {}),
  });

  // 缝 2:出声仲裁闭包查真实 is_speaking——优先 voiceState(VoiceLoop 真状态),
  // 其次 currentSpeakState,最后保守缺省「未在说」。纯函数仲裁(不 import VoiceLoop;§3.1)。
  const readState: () => SpeakState =
    deps.voiceState ?? deps.currentSpeakState ?? (() => ({ isSpeaking: false }));
  const arbiter: SpeakArbiter = {
    requestSpeak: (request: SpeakRequest): SpeakOutcome => arbitrate(request, readState()),
  };

  // 缝 1:shouldPreempt 触发——优先 onPreempt(可观测);否则回落 preempt 触发 VoiceLoop 真打断
  // (受 §7 attention + is_speaking 约束;绝不凌驾用户)。两者皆无则等价现状「仅记录(无操作)」。
  const onPreempt: ((outcome: SpeakOutcome) => void) | undefined =
    deps.onPreempt ?? (deps.preempt ? () => deps.preempt?.('autonomy_preempt') : undefined);

  const runner = new ProactiveTurnRunner({ decisionLlm, arbiter });
  const skill = new AutonomyRunnerSkill({
    runner,
    queue,
    ...(onPreempt ? { onPreempt } : {}),
    ...(deps.candidateSource ? { candidateSource: deps.candidateSource } : {}),
    ...(deps.onProactiveSpeak ? { onProactiveSpeak: deps.onProactiveSpeak } : {}),
  });

  // 调度:enabledSetConfig 启用本技能(其余默认关);scheduler 单循环 reconcile。
  const { config } = enabledSetConfig([AUTONOMY_RUNNER_SKILL_ID]);
  const scheduler = new SkillScheduler(config);
  scheduler.register(skill);

  // 总线 `signal:*` → 优先级队列(经 signal-adapter 鸭子类型识别 + 映射)。
  const unsub = deps.bus.onAny((e) => {
    ingestBusEventAsSignal(e, queue, clock);
  });

  const drive = async (): Promise<void> => {
    try {
      await scheduler.tick();
    } catch (err) {
      // 调度异常已在 scheduler 内部隔离;此处兜底告警不崩(§3.2)。
      stdout.write(`[autonomy] tick 异常(已隔离):${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  // 内部定时器驱动(测试可注入 fake / 不调 stop 即手动 tick)。
  const schedule =
    deps.schedule ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });
  const cancelTimer = schedule(() => void drive(), tickMs);

  let stopped = false;
  return {
    skillId: AUTONOMY_RUNNER_SKILL_ID,
    tickMs,
    tick: drive,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        cancelTimer();
      } catch {
        /* ignore */
      }
      unsub();
    },
  };
}
