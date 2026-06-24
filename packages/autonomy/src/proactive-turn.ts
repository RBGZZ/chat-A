/**
 * ProactiveTurnRunner —— 把「技能候选 → 决策 LLM → persona guardrail → Arbiter.requestSpeak」串成
 * 一次完整主动回合(承 §7 + proactive-turn spec)。
 *
 * 这是决策 LLM 与 requestSpeak 仲裁的**接线核心**:
 *   1. 技能(或 gather)产出**候选发言** + context;
 *   2. `DecisionLlm.decide` 返回 `{silent|speak|idle}`(默认偏 silent,失败退 silent;guardrail 内含);
 *   3. 仅当 `speak` → 经注入的 `requestSpeak` 仲裁(查 VoiceLoop `is_speaking` 硬闸);
 *   4. 仲裁 `speak`(含抢占)→ 由接线层据 `preempted` 触发 abort 三件套(本包只产信号,不 import VoiceLoop)。
 *
 * standalone 解耦(§3.1):requestSpeak 注入为闭包(接线层包 `arbitrate(req, 当前 SpeakState)`),
 * 本类**不直接 import runtime/VoiceLoop**;决策 trace 由 DecisionLlm 内部落(§8.1)。
 */
import type { DecisionLlm, DecisionResult } from './decision-llm';
import type { AutonomyDecisionInput } from './decision-trace';
import type { SpeakArbiter } from './open-thread-skill';
import type { EventPriority, SpeakOutcome, SpeakRequest } from './types';

/** 一次主动回合的输入(候选 + context + 优先级 + 是否可延续)。 */
export interface ProactiveTurnInput {
  readonly skillId: string;
  readonly candidates: readonly string[];
  readonly context?: string;
  /** speak 时提交仲裁的优先级(主动跟进默认 PERCEPTION,不与用户 URGENT 争)。 */
  readonly priority: EventPriority;
  /** 忙时是否可延续(记 history 待续)而非丢弃。 */
  readonly deferrable: boolean;
  /** trace 缝合用 correlationId(可选)。 */
  readonly correlationId?: string;
}

/** 一次主动回合的结果(供接线层据此走 abort 三件套 / 追溯)。 */
export interface ProactiveTurnResult {
  /** 决策 LLM 的裁决。 */
  readonly decision: DecisionResult;
  /** 仅 decision=speak 时有:requestSpeak 仲裁结果。 */
  readonly outcome?: SpeakOutcome;
  /**
   * 接线层是否应触发 abort 三件套:`outcome.decision==='speak' && outcome.preempted`。
   * 本包只产此信号(§4 打断在 runtime 层执行)。
   */
  readonly shouldPreempt: boolean;
}

export interface ProactiveTurnRunnerDeps {
  readonly decisionLlm: DecisionLlm;
  readonly arbiter: SpeakArbiter;
}

export class ProactiveTurnRunner {
  readonly #decisionLlm: DecisionLlm;
  readonly #arbiter: SpeakArbiter;

  constructor(deps: ProactiveTurnRunnerDeps) {
    this.#decisionLlm = deps.decisionLlm;
    this.#arbiter = deps.arbiter;
  }

  /** 跑一次主动回合:候选 → 决策 → (speak 时)仲裁。 */
  async run(input: ProactiveTurnInput): Promise<ProactiveTurnResult> {
    const decisionInput: AutonomyDecisionInput = {
      candidates: input.candidates,
      ...(input.context !== undefined ? { context: input.context } : {}),
    };
    const decision = await this.#decisionLlm.decide(decisionInput, {
      skillId: input.skillId,
      ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
    });

    if (decision.decision !== 'speak' || decision.text === undefined) {
      return { decision, shouldPreempt: false };
    }

    const request: SpeakRequest = {
      skillId: input.skillId,
      priority: input.priority,
      deferrable: input.deferrable,
      text: decision.text,
    };
    const outcome = this.#arbiter.requestSpeak(request);
    return {
      decision,
      outcome,
      shouldPreempt: outcome.decision === 'speak' && outcome.preempted,
    };
  }
}
