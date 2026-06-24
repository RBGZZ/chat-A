import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type {
  AnchorResult,
  SelfConsistencyContext,
  SelfConsistencyGuard,
} from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/**
 * 自我一致性 Guard 接进回合流程(companion-coherence-wiring,§6.1):
 * - 注入 Guard 判 drift → **下一轮** prompt 含温和重锚段([自我一致性])。
 * - 不漂移 → 下轮不重锚。
 * - 不注入 Guard(默认)→ 回合正常、永不重锚(回归绿)。
 * - Guard 抛错 → 回合不崩、回复正常。
 * 全部用 recordingLlm + 假 Guard,不触网。
 */

/** 记录每轮传给 LLM 的 system(验下轮是否注入重锚)。 */
function recordingLlm(): { llm: LlmProvider; systems: string[] } {
  const systems: string[] = [];
  const llm: LlmProvider = {
    id: 'rec',
    model: 'rec-1',
    async *stream(req) {
      systems.push(req.system);
      yield 'ok';
    },
    async complete() {
      return 'ok';
    },
  };
  return { llm, systems };
}

/** 可编程假 Guard:记录每次 check 入参,按注入序返回 drift 结论。 */
function fakeGuard(results: readonly AnchorResult[]): {
  guard: SelfConsistencyGuard;
  calls: SelfConsistencyContext[];
} {
  const calls: SelfConsistencyContext[] = [];
  let i = 0;
  const guard: SelfConsistencyGuard = {
    check(ctx): Promise<AnchorResult> {
      calls.push(ctx);
      const r = results[Math.min(i, results.length - 1)] ?? { drift: false };
      i += 1;
      return Promise.resolve(r);
    },
  };
  return { guard, calls };
}

const REANCHOR_MARK = '[自我一致性]';

describe('runtime/自我一致性 Guard 接进回合流程(§6.1)', () => {
  it('注入 Guard 判 drift → 下一轮注入温和重锚', async () => {
    const { llm, systems } = recordingLlm();
    const { guard, calls } = fakeGuard([{ drift: true, anchorText: '我叫小雪' }]);
    const convo = new Conversation({
      bus: new LightVoiceBus(),
      llm,
      selfConsistencyGuard: guard,
      sessionId: 's-drift',
    });
    await convo.send('第一句', () => {});
    await convo.send('第二句', () => {});
    // 第一轮 prompt 还没有重锚(Guard 在回复后才判);第二轮应注入重锚段。
    expect(systems[0]).not.toContain(REANCHOR_MARK);
    expect(systems[1]).toContain(REANCHOR_MARK);
    expect(systems[1]).toContain('我叫小雪');
    // Guard 被调用(回复生成后),入参带 agentName。
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.agentName).toBeDefined();
  });

  it('drift 的重锚仅注入下一轮、不粘连第三轮(用过即清)', async () => {
    const { llm, systems } = recordingLlm();
    // 第一轮回复后判 drift;之后不漂移。
    const { guard } = fakeGuard([{ drift: true, anchorText: '我叫小雪' }, { drift: false }]);
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, selfConsistencyGuard: guard, sessionId: 's-once' });
    await convo.send('一', () => {});
    await convo.send('二', () => {});
    await convo.send('三', () => {});
    expect(systems[1]).toContain(REANCHOR_MARK); // 第二轮重锚
    expect(systems[2]).not.toContain(REANCHOR_MARK); // 第三轮不再粘连
  });

  it('注入 Guard 但不漂移 → 下轮不重锚', async () => {
    const { llm, systems } = recordingLlm();
    const { guard } = fakeGuard([{ drift: false }]);
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, selfConsistencyGuard: guard, sessionId: 's-nodrift' });
    await convo.send('一', () => {});
    await convo.send('二', () => {});
    expect(systems[0]).not.toContain(REANCHOR_MARK);
    expect(systems[1]).not.toContain(REANCHOR_MARK);
  });

  it('不注入 Guard(默认)→ 回合正常、永不重锚(回归绿)', async () => {
    const { llm, systems } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's-off' });
    const reply = await convo.send('你好', () => {});
    await convo.send('再说一句', () => {});
    expect(reply).toBe('ok');
    expect(systems.every((s) => !s.includes(REANCHOR_MARK))).toBe(true);
  });

  it('Guard 抛错 → 回合不崩、回复正常、下轮不重锚(降级 §3.2)', async () => {
    const { llm, systems } = recordingLlm();
    const guard: SelfConsistencyGuard = {
      check(): Promise<AnchorResult> {
        return Promise.reject(new Error('boom'));
      },
    };
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, selfConsistencyGuard: guard, sessionId: 's-err' });
    const r1 = await convo.send('一', () => {});
    const r2 = await convo.send('二', () => {});
    expect(r1).toBe('ok');
    expect(r2).toBe('ok');
    expect(systems[1]).not.toContain(REANCHOR_MARK);
  });
});
