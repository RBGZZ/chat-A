/**
 * 每日主动开口上限闸(§11 调参)的确定性测试:
 *   - 注入 clock(可推进到次日)+ rng 恒过衰减闸 + fake llm 恒返回 speak JSON;
 *   - 同一天达上限后强制 silent(reason 含「上限」),且达上限后不再调 LLM;
 *   - 跨日重置后又能 speak;
 *   - dailyCap=0/不传 → 不限;
 *   - silent/idle 决策不计入额度。
 */
import { describe, expect, it } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import { DecisionLlm } from '../src/decision-llm';
import { InMemoryAutonomyDecisionSink } from '../src/decision-trace';
import type { Clock } from '../src/types';

/** 可推进的 fake clock(注入,确定可测)。 */
function mutableClock(startMs: number): Clock & { set(ms: number): void } {
  let now = startMs;
  return {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** rng 恒返回 0 → 衰减闸恒放行(去问 LLM)。 */
const alwaysPass = (): number => 0;
/** rng 恒返回 1 → 衰减闸恒不放行(→ silent,不问 LLM)。 */
const neverPass = (): number => 1;

/** 计调用次数的 speak LLM(可断言 LLM 是否被问)。 */
function speakSpyLlm(): LlmProvider & { calls: number } {
  const obj = {
    id: 'spy-speak',
    model: 'spy-speak',
    calls: 0,
    async *stream() {},
    async complete(): Promise<string> {
      obj.calls += 1;
      return '{"decision":"speak","reason":"想说","text":"嗨~"}';
    },
  };
  return obj;
}

describe('autonomy/DecisionLlm 每日主动开口上限(§11 调参)', () => {
  it('同一天连续 speak 到上限后强制 silent,且达上限后不再问 LLM', async () => {
    const clock = mutableClock(1000); // 1970-01-01
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = speakSpyLlm();
    const d = new DecisionLlm({ llm, clock, sink, rng: alwaysPass, dailyCap: 3 });

    // 前 3 次都能 speak。
    for (let i = 0; i < 3; i++) {
      const r = await d.decide({ candidates: ['x'] });
      expect(r.decision).toBe('speak');
    }
    expect(llm.calls).toBe(3);

    // 第 4 次:达上限 → 强制 silent,reason 含「上限」,且未再问 LLM。
    const r4 = await d.decide({ candidates: ['x'] });
    expect(r4.decision).toBe('silent');
    expect(r4.fellBack).toBe(false);
    expect(r4.reason).toContain('上限');
    expect(llm.calls).toBe(3); // LLM 没被第 4 次调用

    // trace 照常记(4 条,最后一条为达上限的 silent)。
    expect(sink.traces).toHaveLength(4);
    expect(sink.traces[3]!.decision).toBe('silent');
    expect(sink.traces[3]!.reason).toContain('上限');
  });

  it('跨日后计数重置,又能 speak', async () => {
    const clock = mutableClock(1000);
    const llm = speakSpyLlm();
    const d = new DecisionLlm({ llm, clock, rng: alwaysPass, dailyCap: 1 });

    // 当天 1 次 speak,第 2 次达上限 silent。
    expect((await d.decide({ candidates: ['x'] })).decision).toBe('speak');
    expect((await d.decide({ candidates: ['x'] })).decision).toBe('silent');

    // 推进到次日 → 计数重置,又能 speak。
    clock.set(1000 + DAY_MS);
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('speak');
  });

  it('dailyCap=0 → 不限,多次都能 speak', async () => {
    const clock = mutableClock(1000);
    const llm = speakSpyLlm();
    const d = new DecisionLlm({ llm, clock, rng: alwaysPass, dailyCap: 0 });
    for (let i = 0; i < 10; i++) {
      expect((await d.decide({ candidates: ['x'] })).decision).toBe('speak');
    }
  });

  it('不传 dailyCap → 缺省不限,多次都能 speak', async () => {
    const clock = mutableClock(1000);
    const llm = speakSpyLlm();
    const d = new DecisionLlm({ llm, clock, rng: alwaysPass });
    for (let i = 0; i < 10; i++) {
      expect((await d.decide({ candidates: ['x'] })).decision).toBe('speak');
    }
  });

  it('silent 决策不计入额度(同实例可切换 rng:先多次 silent 再放行仍在额度内)', async () => {
    const clock = mutableClock(1000);
    const llm = speakSpyLlm();
    let pass = false; // 可切换:false→衰减闸拒(silent),true→放行(speak)
    const d = new DecisionLlm({ llm, clock, rng: () => (pass ? 0 : 1), dailyCap: 1 });

    // 先 3 次 silent(衰减闸恒拒),不计数、不问 LLM。
    for (let i = 0; i < 3; i++) {
      expect((await d.decide({ candidates: ['x'] })).decision).toBe('silent');
    }
    expect(llm.calls).toBe(0);

    // 放行 → 仍有 1 次 speak 额度(前面 silent 没耗额度)。
    pass = true;
    expect((await d.decide({ candidates: ['x'] })).decision).toBe('speak');
    // 再一次 → 已达上限,强制 silent。
    const capped = await d.decide({ candidates: ['x'] });
    expect(capped.decision).toBe('silent');
    expect(capped.reason).toContain('上限');
  });
});
