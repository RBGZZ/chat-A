import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { LlmOceanEvolver } from '../src/index';

const CTX = {
  recentUserTexts: ['今天去爬山了，认识了好多新朋友', '又报名了一个新课'],
  ocean: { openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 },
  turn: 20,
};

describe('persona/LlmOceanEvolver (record-replay)', () => {
  it('合规 JSON(含围栏/越界)→ 钳制到 ±0.01 的 delta', async () => {
    const provider = new FakeLlm('fake', {
      complete:
        '分析结果:\n```json\n{"openness":0.5,"conscientiousness":0,"extraversion":0.005,"agreeableness":-1,"neuroticism":0}\n```',
    });
    const delta = await new LlmOceanEvolver({ provider }).evolve(CTX);
    expect(delta).not.toBeNull();
    expect(delta!.openness).toBe(0.01); // 0.5 越界 → 钳到上限
    expect(delta!.extraversion).toBeCloseTo(0.005);
    expect(delta!.agreeableness).toBe(-0.01); // -1 越界 → 钳到下限
    expect(delta!.conscientiousness).toBe(0);
  });

  it('乱码/无有效维度 → null(本次不演化,降级)', async () => {
    const provider = new FakeLlm('fake', { complete: '抱歉我不会输出 JSON' });
    const delta = await new LlmOceanEvolver({ provider }).evolve(CTX);
    expect(delta).toBeNull();
  });

  it('provider 抛异常 → null(降级,不抛)', async () => {
    const provider: { complete: () => Promise<string> } = {
      complete: () => Promise.reject(new Error('boom')),
    };
    // 仅用到 complete;以最小桩冒充 LlmProvider。
    let errSeen = false;
    const delta = await new LlmOceanEvolver({ provider: provider as never, onError: () => (errSeen = true) }).evolve(CTX);
    expect(delta).toBeNull();
    expect(errSeen).toBe(true); // 异常路径触发 onError(供 trace)
  });
});
