/**
 * 主动陪伴桥(代理B,承北极星「会主动开口」+ §7):把既有 autonomy 引擎接成一个**端到端可产
 * 一条真实主动气泡**的最小可用切片——
 *
 *   1. **可配置 idle 触发**:每 `CHAT_A_PROACTIVE_IDLE_MS`(默认 30s)向 A 层总线发一条
 *      `signal:perception`(`temporal:idle-tick`),驱动既有 autonomy `signal:*` 入队回路;
 *   2. **真候选(persona/memory)**:复用装配层 `createCompanionCandidateSource`(未了话题 + idle 想念弧),
 *      候选来自真记忆;
 *   3. **persona/memory 感知决策**:决策 LLM 的 system 提示由注入的 `composeSystemPrompt()` 产
 *      (装配层传 `() => convo.composeOmniInstructions()` —— persona 骨架 + 记忆召回 + 语气),
 *      使主动话语真走人格/记忆而非硬编码;
 *   4. **推送通道**:仲裁真说 → `onProactiveSpeak(speech)` 推出(desktop 据此渲染自发气泡)。
 *
 * **默认关**:仅 `CHAT_A_AUTONOMY=on` 才装配(复用 {@link assembleAutonomy} 的开关);off → undefined。
 * 决策仍是唯一「是否值得说」裁决(schema/概率闸/退 silent/落 trace 全不变,restraint-first);
 * idle 触发只是**喂一拍**,绝不等于必说。
 *
 * **不涉及 TTS 语种**:本桥只把主动话推成**文字气泡**(desktop renderer `addBubble`),不经 TTS 朗读。
 * 若后续要让主动话发声,应沿用既有 VoiceLoop / TTS 的 `language_type` 输出语种路径(输出语种由配置/人格
 * 决定、与输入语种解耦,见 voice-api-calibration),**不要**在此绕过——本桥不引入任何语种硬绑。
 *
 * standalone 解耦(§3.1):只依赖 `@chat-a/runtime` 总线 + `@chat-a/autonomy` 类型 + 装配层端口,
 * 决策出声经注入闭包,**不 import VoiceLoop 内部**。
 */
import { LightVoiceBus } from '@chat-a/runtime';
import type { LlmProvider } from '@chat-a/providers';
import { makeBusEvent } from '@chat-a/protocol';
import {
  isAutonomyEnabled,
  systemClock,
  type AutonomyDecisionSink,
  type Clock,
  type ProactiveCandidateSource,
} from '@chat-a/autonomy';
import { assembleAutonomy, type AutonomyHandle, type ProactiveSpeech } from './autonomy';

/** 主动陪伴 idle 触发默认周期(ms):30s 无活跃即喂一拍(非热路径,克制优先)。 */
export const DEFAULT_PROACTIVE_IDLE_MS = 30_000;

/** idle 触发用的感知信号 kind(单一权威常量;便于 trace / UI 标注)。 */
export const PROACTIVE_IDLE_SIGNAL_KIND = 'temporal:idle-tick';

/**
 * 解析主动 idle 触发周期:`CHAT_A_PROACTIVE_IDLE_MS`,非法/缺省回落默认(>0 整数)。
 * env 可注入(确定性测试);缺省读 process.env。
 */
export function loadProactiveIdleMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env['CHAT_A_PROACTIVE_IDLE_MS'] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_PROACTIVE_IDLE_MS;
}

export interface ProactiveBridgeDeps {
  /** A 层总线(与大脑同一条:idle 信号经此入 autonomy,主动话经此不发——直接走回调)。 */
  readonly bus: LightVoiceBus;
  /** LLM provider(决策 LLM 用;同大脑那颗)。 */
  readonly llm: LlmProvider;
  /**
   * persona/memory 感知的决策 system 提示来源(装配层传 `() => convo.composeOmniInstructions()`)。
   * 桥在挂载时取一次作决策 LLM 的 system 提示(失败/空回落 DecisionLlm 内置提示,§3.2)。
   */
  readonly composeSystemPrompt: () => string | Promise<string>;
  /** 真候选源(persona/memory:未了话题 + idle 想念弧);装配层传 createCompanionCandidateSource(...)。 */
  readonly candidateSource: ProactiveCandidateSource;
  /** 主动话推送回调(desktop 传 `(s) => emit(IPC.proactiveMessage, ...)`);不传则只落 trace。 */
  readonly onProactiveSpeak?: (speech: ProactiveSpeech) => void;
  /** 决策 trace sink(可选;接线层提供 SQLite 实现)。 */
  readonly decisionSink?: AutonomyDecisionSink;
  /** 注入时钟(确定性测试);缺省 systemClock。 */
  readonly clock?: Clock;
  /** 注入 idle 定时器(确定性测试);缺省 setInterval。返回取消句柄。 */
  readonly scheduleIdle?: (fn: () => void, periodMs: number) => () => void;
  /** 注入 autonomy tick 定时器(透传给 assembleAutonomy;确定性测试)。 */
  readonly scheduleAutonomy?: (fn: () => void, periodMs: number) => () => void;
  /** 决策概率闸 rng(确定性测试可注入恒过/恒拒);缺省 Math.random(restraint-first)。 */
  readonly decisionRng?: () => number;
}

/** 主动陪伴桥句柄:手动驱动 idle / autonomy tick(测试确定性);stop 收尾。 */
export interface ProactiveBridgeHandle {
  /** 推一次 idle tick(发一条 idle signal 到总线;测试可手动驱动)。 */
  idleTick(): void;
  /** 推一次 autonomy scheduler tick(测试可手动驱动)。 */
  autonomyTick(): Promise<void>;
  /** idle 触发周期(ms)。 */
  readonly idleMs: number;
  /** 停:停 idle 定时器 + 停 autonomy(退订总线 + 停其定时器)。幂等。 */
  stop(): void;
}

/**
 * 按开关装配主动陪伴桥。off(`CHAT_A_AUTONOMY` ≠ on)→ undefined(不挂任何东西、零开销)。
 * on → 取一次 persona/memory 决策提示 → 装 autonomy(注入真候选源 + 推送回调 + persona 提示)→
 * 挂 idle 定时器(周期发 idle signal 驱动 autonomy)。
 *
 * 注意:`composeSystemPrompt()` 在装配时取一次(主动决策非高频,提示随大脑当前心情/记忆而定的
 * 「快照」已足够最小切片;后续可改为每决策现取)。失败/空 → 不传 systemPrompt(DecisionLlm 回落内置)。
 */
export async function assembleProactiveBridge(
  env: NodeJS.ProcessEnv,
  deps: ProactiveBridgeDeps,
): Promise<ProactiveBridgeHandle | undefined> {
  if (!isAutonomyEnabled(env)) return undefined;

  const clock = deps.clock ?? systemClock;
  const idleMs = loadProactiveIdleMs(env);

  // persona/memory 感知决策提示(失败/空回落 DecisionLlm 内置「多数沉默」提示,§3.2)。
  let decisionSystemPrompt: string | undefined;
  try {
    const p = (await deps.composeSystemPrompt())?.trim();
    if (p && p.length > 0) decisionSystemPrompt = p;
  } catch {
    /* 取提示失败:回落内置提示,不中断装配(§3.2) */
  }

  const autonomy: AutonomyHandle | undefined = assembleAutonomy(env, {
    bus: deps.bus,
    llm: deps.llm,
    clock,
    candidateSource: deps.candidateSource,
    ...(deps.onProactiveSpeak ? { onProactiveSpeak: deps.onProactiveSpeak } : {}),
    ...(deps.decisionSink ? { decisionSink: deps.decisionSink } : {}),
    ...(deps.scheduleAutonomy ? { schedule: deps.scheduleAutonomy } : {}),
    ...(deps.decisionRng ? { decisionRng: deps.decisionRng } : {}),
    ...(decisionSystemPrompt ? { decisionSystemPrompt } : {}),
  });
  // isAutonomyEnabled 已为 true,assembleAutonomy 必返回句柄;防御性兜底。
  if (autonomy === undefined) return undefined;

  // idle tick:向总线发一条感知信号,驱动既有 autonomy `signal:*` 入队回路。
  let seq = 0;
  const idleTick = (): void => {
    const correlationId = `proactive/idle/${seq++}`;
    try {
      deps.bus.emit(
        makeBusEvent(
          'signal:perception',
          {
            kind: PROACTIVE_IDLE_SIGNAL_KIND,
            description: '已经有一会儿没说话了',
            confidence: 1,
          },
          correlationId,
        ),
      );
    } catch {
      /* 发信号失败不影响主链路(§3.2) */
    }
  };

  const scheduleIdle =
    deps.scheduleIdle ??
    ((fn, ms) => {
      const t = setInterval(fn, ms);
      return () => clearInterval(t);
    });
  const cancelIdle = scheduleIdle(idleTick, idleMs);

  let stopped = false;
  return {
    idleTick,
    autonomyTick: () => autonomy.tick(),
    idleMs,
    stop: () => {
      if (stopped) return;
      stopped = true;
      try {
        cancelIdle();
      } catch {
        /* ignore */
      }
      autonomy.stop();
    },
  };
}
