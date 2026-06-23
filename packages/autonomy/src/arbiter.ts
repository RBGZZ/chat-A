/**
 * requestSpeak 输出仲裁器(确定性纯函数内核,承 §7 / neuro-ecosystem-findings §5)。
 *
 * 所有后台技能"想说"走同一入口,据**单一 `is_speaking` 硬闸** + 优先级/抢占,裁决:
 * - `speak`:真说(空闲;或忙但来者优先级更高 → 抢占,`preempted=true`)。
 * - `defer`:记 history 待续(忙、不抢占、但可延续 `deferrable`)。
 * - `drop`:丢弃(忙、不抢占、不可延续)。
 *
 * 设计为**纯函数**:播放状态由入参 `state` 提供,仲裁器内部零状态(利 golden test)。
 * 抢占只产出 `preempted` 信号,**不在此真做 abort 三件套**(那在 runtime 层,§4 打断)。
 */
import { PRIORITY_RANK, type SpeakOutcome, type SpeakRequest, type SpeakState } from './types';

/**
 * 仲裁一次发言请求。
 *
 * 规则(单一权威):
 * 1. `!isSpeaking` → `speak`(空闲放行,不抢占)。
 * 2. `isSpeaking` 且来者优先级 **严格高于** 在说者 → `speak` + `preempted=true`(抢占)。
 *    - 在说者优先级缺省(`speakingPriority` 未给)时按最低优先级看待 → 任何来者都可抢占。
 * 3. `isSpeaking` 且不抢占,但 `deferrable` → `defer`(记 history 待续)。
 * 4. 其余 → `drop`。
 */
export function arbitrate(request: SpeakRequest, state: SpeakState): SpeakOutcome {
  if (!state.isSpeaking) {
    return { decision: 'speak', preempted: false, reason: 'idle: 空闲直接放行' };
  }

  const incoming = PRIORITY_RANK[request.priority];
  // 在说者优先级缺省时按最低(LOWEST 之下)看待,使任何明确优先级都能抢占。
  const current =
    state.speakingPriority === undefined ? 0 : PRIORITY_RANK[state.speakingPriority];

  if (incoming > current) {
    return {
      decision: 'speak',
      preempted: true,
      reason: `preempt: 来者(${request.priority})高于在说者 → 抢占`,
    };
  }

  if (request.deferrable) {
    return { decision: 'defer', preempted: false, reason: 'busy: 不抢占但可延续 → 记 history 待续' };
  }

  return { decision: 'drop', preempted: false, reason: 'busy: 不抢占且不可延续 → 丢弃' };
}
