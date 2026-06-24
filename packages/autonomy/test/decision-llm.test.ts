import { describe, expect, it } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import type { LlmProvider, LlmRequest } from '@chat-a/providers';
import { DecisionLlm, parseDecision, speakGovernorPass } from '../src/decision-llm';
import { InMemoryAutonomyDecisionSink } from '../src/decision-trace';
import type { Clock } from '../src/types';

const fixedClock: Clock = { now: () => 1000 };

/** rng 恒返回 0 → 衰减闸恒放行(去问 LLM);恒返回 1 → 恒不放行。 */
const alwaysPass = (): number => 0;
const neverPass = (): number => 1;

/** 用 complete 罐装一段 JSON 的 FakeLlm。 */
function jsonLlm(json: string): LlmProvider {
  return new FakeLlm('fake-decide', { complete: json });
}

describe('autonomy/DecisionLlm(silent|speak|idle 决策 LLM)', () => {
  it('speak:模型判定开口 → 过 guardrail → speak + text', async () => {
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = jsonLlm('{"decision":"speak","reason":"值得跟进","text":"你昨天面试怎么样?"}');
    const d = new DecisionLlm({ llm, clock: fixedClock, sink, rng: alwaysPass });
    const r = await d.decide({ candidates: ['你昨天面试怎么样?'] }, { skillId: 'open-thread' });
    expect(r.decision).toBe('speak');
    expect(r.text).toBe('你昨天面试怎么样?');
    expect(r.fellBack).toBe(false);
    // trace 落库
    expect(sink.traces).toHaveLength(1);
    expect(sink.traces[0]!.decision).toBe('speak');
    expect(sink.traces[0]!.skillId).toBe('open-thread');
    expect(sink.traces[0]!.input.candidates).toEqual(['你昨天面试怎么样?']);
  });

  it('silent:模型判定沉默 → silent,不出声', async () => {
    const sink = new InMemoryAutonomyDecisionSink();
    const llm = jsonLlm('{"decision":"silent","reason":"此刻无需开口"}');
    const d = new DecisionLlm({ llm, clock: fixedClock, sink, rng: alwaysPass });
    const r = await d.decide({ candidates: ['随便说点'] });
    expect(r.decision).toBe('silent');
    expect(r.text).toBeUndefined();
    expect(sink.traces[0]!.decision).toBe('silent');
  });

  it('idle:模型判定空闲 → idle', async () => {
    const llm = jsonLlm('{"decision":"idle","reason":"无事可做"}');
    const d = new DecisionLlm({ llm, clock: fixedClock, rng: alwaysPass });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('idle');
  });

  it('失败退 silent:LLM 抛错 → silent + fellBack', async () => {
    const sink = new InMemoryAutonomyDecisionSink();
    const boom: LlmProvider = {
      id: 'boom',
      model: 'boom',
      async *stream() {},
      async complete(): Promise<string> {
        throw new Error('LLM 崩了');
      },
    };
    const d = new DecisionLlm({ llm: boom, clock: fixedClock, sink, rng: alwaysPass });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('silent');
    expect(r.fellBack).toBe(true);
    expect(sink.traces[0]!.fellBack).toBe(true);
  });

  it('超时退 silent:LLM 超时 → silent + fellBack', async () => {
    const sink = new InMemoryAutonomyDecisionSink();
    const slow: LlmProvider = {
      id: 'slow',
      model: 'slow',
      async *stream() {},
      complete(_req: LlmRequest, signal?: AbortSignal): Promise<string> {
        return new Promise<string>((resolve, reject) => {
          const t = setTimeout(() => resolve('{"decision":"speak","text":"晚了"}'), 5000);
          signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      },
    };
    const d = new DecisionLlm({ llm: slow, clock: fixedClock, sink, rng: alwaysPass, timeoutMs: 20 });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('silent');
    expect(r.fellBack).toBe(true);
  });

  it('非法 JSON 退 silent + fellBack', async () => {
    const llm = jsonLlm('这不是 JSON');
    const d = new DecisionLlm({ llm, clock: fixedClock, rng: alwaysPass });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('silent');
    expect(r.fellBack).toBe(true);
  });

  it('衰减概率闸未放行 → 直接 silent(不问 LLM)', async () => {
    let called = 0;
    const llm: LlmProvider = {
      id: 'spy',
      model: 'spy',
      async *stream() {},
      async complete(): Promise<string> {
        called++;
        return '{"decision":"speak","text":"x"}';
      },
    };
    const d = new DecisionLlm({ llm, clock: fixedClock, rng: neverPass });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('silent');
    expect(called).toBe(0); // 连 LLM 都没问
  });

  it('无候选 → silent(不问 LLM)', async () => {
    let called = 0;
    const llm: LlmProvider = {
      id: 'spy',
      model: 'spy',
      async *stream() {},
      async complete(): Promise<string> {
        called++;
        return '{"decision":"speak","text":"x"}';
      },
    };
    const d = new DecisionLlm({ llm, clock: fixedClock, rng: alwaysPass });
    const r = await d.decide({ candidates: [] });
    expect(r.decision).toBe('silent');
    expect(called).toBe(0);
  });

  it('persona guardrail 否决 speak → silent', async () => {
    const llm = jsonLlm('{"decision":"speak","reason":"想说","text":"不合规的话"}');
    const d = new DecisionLlm({
      llm,
      clock: fixedClock,
      rng: alwaysPass,
      guardrail: { check: () => ({ ok: false, reason: '违反人格底线' }) },
    });
    const r = await d.decide({ candidates: ['不合规的话'] });
    expect(r.decision).toBe('silent');
    expect(r.reason).toContain('guardrail');
  });

  it('guardrail 改写 text → 采纳改写后的话', async () => {
    const llm = jsonLlm('{"decision":"speak","text":"原话"}');
    const d = new DecisionLlm({
      llm,
      clock: fixedClock,
      rng: alwaysPass,
      guardrail: { check: () => ({ ok: true, text: '改写后的话' }) },
    });
    const r = await d.decide({ candidates: ['原话'] });
    expect(r.text).toBe('改写后的话');
  });

  it('speak 但无 text → 降级 silent', async () => {
    const llm = jsonLlm('{"decision":"speak","reason":"想说但没给话"}');
    const d = new DecisionLlm({ llm, clock: fixedClock, rng: alwaysPass });
    const r = await d.decide({ candidates: ['x'] });
    expect(r.decision).toBe('silent');
    expect(r.fellBack).toBe(true);
  });
});

describe('autonomy/parseDecision + speakGovernorPass', () => {
  it('parseDecision 容错:剥围栏', () => {
    const p = parseDecision('```json\n{"decision":"speak","text":"hi"}\n```');
    expect(p?.decision).toBe('speak');
    expect(p?.text).toBe('hi');
  });
  it('parseDecision 非法 decision → null', () => {
    expect(parseDecision('{"decision":"maybe"}')).toBeNull();
  });
  it('speakGovernorPass:rate=0 恒不过,rate=1 恒过', () => {
    expect(speakGovernorPass({ baseSpeakRate: 0, affectBias: 0 }, () => 0)).toBe(false);
    expect(speakGovernorPass({ baseSpeakRate: 1, affectBias: 0 }, () => 0.99)).toBe(true);
  });
  it('speakGovernorPass:affectBias 正向提高放行率', () => {
    // base 0.2 + bias 1*0.5 = 0.7;rng 0.5 < 0.7 → 过
    expect(speakGovernorPass({ baseSpeakRate: 0.2, affectBias: 1 }, () => 0.5)).toBe(true);
    // base 0.2 + bias -1*0.5 = 0(clamp);rng 0 not < 0 → 不过
    expect(speakGovernorPass({ baseSpeakRate: 0.2, affectBias: -1 }, () => 0)).toBe(false);
  });
});
