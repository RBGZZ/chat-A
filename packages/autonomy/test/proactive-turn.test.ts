import { describe, expect, it } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { DecisionLlm } from '../src/decision-llm';
import { ProactiveTurnRunner } from '../src/proactive-turn';
import { arbitrate } from '../src/arbiter';
import type { SpeakArbiter } from '../src/open-thread-skill';
import type { SpeakRequest, SpeakState } from '../src/types';
import type { Clock } from '../src/types';

const clock: Clock = { now: () => 1000 };
const alwaysPass = (): number => 0;

/** 把 arbitrate 包成注入闭包(查给定 is_speaking 状态)。 */
function arbiterFor(state: SpeakState): SpeakArbiter {
  return { requestSpeak: (req: SpeakRequest) => arbitrate(req, state) };
}

describe('autonomy/ProactiveTurnRunner(候选→决策 LLM→requestSpeak 仲裁)', () => {
  it('speak + 空闲 → 仲裁 speak,不抢占', async () => {
    const decisionLlm = new DecisionLlm({
      llm: new FakeLlm('d', { complete: '{"decision":"speak","text":"嗨,在忙吗?"}' }),
      clock,
      rng: alwaysPass,
    });
    const runner = new ProactiveTurnRunner({ decisionLlm, arbiter: arbiterFor({ isSpeaking: false }) });
    const r = await runner.run({
      skillId: 'open-thread',
      candidates: ['嗨,在忙吗?'],
      priority: 'PERCEPTION',
      deferrable: true,
    });
    expect(r.decision.decision).toBe('speak');
    expect(r.outcome?.decision).toBe('speak');
    expect(r.shouldPreempt).toBe(false);
  });

  it('speak + 忙(低优先在说)→ URGENT 抢占 → shouldPreempt', async () => {
    const decisionLlm = new DecisionLlm({
      llm: new FakeLlm('d', { complete: '{"decision":"speak","text":"等一下!"}' }),
      clock,
      rng: alwaysPass,
    });
    const runner = new ProactiveTurnRunner({
      decisionLlm,
      arbiter: arbiterFor({ isSpeaking: true, speakingPriority: 'LOWEST' }),
    });
    const r = await runner.run({
      skillId: 'crisis',
      candidates: ['等一下!'],
      priority: 'URGENT',
      deferrable: false,
    });
    expect(r.outcome?.decision).toBe('speak');
    expect(r.outcome?.preempted).toBe(true);
    expect(r.shouldPreempt).toBe(true);
  });

  it('silent → 不仲裁,无 outcome', async () => {
    const decisionLlm = new DecisionLlm({
      llm: new FakeLlm('d', { complete: '{"decision":"silent","reason":"克制"}' }),
      clock,
      rng: alwaysPass,
    });
    const runner = new ProactiveTurnRunner({ decisionLlm, arbiter: arbiterFor({ isSpeaking: false }) });
    const r = await runner.run({
      skillId: 'open-thread',
      candidates: ['x'],
      priority: 'PERCEPTION',
      deferrable: true,
    });
    expect(r.decision.decision).toBe('silent');
    expect(r.outcome).toBeUndefined();
    expect(r.shouldPreempt).toBe(false);
  });
});
