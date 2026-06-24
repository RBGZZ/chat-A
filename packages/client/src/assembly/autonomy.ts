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
import type { LightVoiceBus } from '@chat-a/runtime';
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

/**
 * 把 {@link ProactiveTurnRunner} 包成一个后台技能:每 tick 从队列取一条 signal,
 * 据其组织候选 + context 跑一次主动回合。`shouldPreempt` 时 MVP 仅记录(不强接 VoiceLoop abort)。
 */
export class AutonomyRunnerSkill implements BaseSkill {
  readonly id = AUTONOMY_RUNNER_SKILL_ID;
  readonly #runner: ProactiveTurnRunner;
  readonly #queue: PriorityEventQueue;
  readonly #onPreempt: ((outcome: SpeakOutcome) => void) | undefined;

  constructor(deps: {
    readonly runner: ProactiveTurnRunner;
    readonly queue: PriorityEventQueue;
    readonly onPreempt?: (outcome: SpeakOutcome) => void;
  }) {
    this.#runner = deps.runner;
    this.#queue = deps.queue;
    this.#onPreempt = deps.onPreempt;
  }

  async tick(): Promise<void> {
    const event = this.#queue.dequeue();
    if (event === undefined) return; // 队列空:本 tick 无事可做。
    // 候选:用 signal 的描述当线索(MVP);真候选生成属技能领域,后续可丰富。
    const description =
      typeof (event.payload as { description?: unknown } | undefined)?.description === 'string'
        ? (event.payload as { description: string }).description
        : event.kind;
    const result = await this.#runner.run({
      skillId: this.id,
      candidates: [description],
      context: `感知信号: ${event.kind}`,
      priority: event.priority,
      deferrable: true,
    });
    if (result.shouldPreempt && result.outcome) {
      this.#onPreempt?.(result.outcome);
    }
  }
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
  /** is_speaking 硬闸读取(MVP 缺省「未在说」;真状态由 runtime 层维护)。 */
  readonly currentSpeakState?: () => SpeakState;
  /** 抢占信号回调(MVP 仅记录;真 abort 在 runtime 层)。 */
  readonly onPreempt?: (outcome: SpeakOutcome) => void;
  /** 决策概率闸的 rng(确定性测试可注入恒过/恒拒);缺省 Math.random(restraint-first)。 */
  readonly decisionRng?: () => number;
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
  const decisionLlm = new DecisionLlm({
    llm: deps.llm,
    clock,
    ...(deps.decisionSink ? { sink: deps.decisionSink } : {}),
    ...(deps.decisionRng ? { rng: deps.decisionRng } : {}),
  });

  // 出声仲裁闭包:查当前 is_speaking 后纯函数仲裁(不 import VoiceLoop;§3.1)。
  const readState: () => SpeakState = deps.currentSpeakState ?? (() => ({ isSpeaking: false }));
  const arbiter: SpeakArbiter = {
    requestSpeak: (request: SpeakRequest): SpeakOutcome => arbitrate(request, readState()),
  };

  const runner = new ProactiveTurnRunner({ decisionLlm, arbiter });
  const skill = new AutonomyRunnerSkill({
    runner,
    queue,
    ...(deps.onPreempt ? { onPreempt: deps.onPreempt } : {}),
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
