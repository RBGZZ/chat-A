import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { LlmAppraiser, type Appraiser } from '../src/index';

const CTX = { userText: 'x', pad: { pleasure: 0, arousal: 0, dominance: 0 }, turn: 1 };

describe('persona/LlmAppraiser (record-replay)', () => {
  it('合规 JSON(含围栏/越界)→ 钳制后的 PAD pull', async () => {
    const provider = new FakeLlm('fake', {
      complete: '评估如下:\n```json\n{"pleasure":-0.8,"arousal":0.4,"dominance":-2}\n```',
    });
    const pull = await new LlmAppraiser({ provider }).appraise({ ...CTX, userText: '我很难过' });
    expect(pull.pleasure).toBeCloseTo(-0.8);
    expect(pull.arousal).toBeCloseTo(0.4);
    expect(pull.dominance).toBe(-1); // 越界被钳制到 [-1,1]
  });

  it('乱码 → 回退到注入的确定性 fallback', async () => {
    const provider = new FakeLlm('fake', { complete: '抱歉我不会输出 JSON' });
    const sentinel: Appraiser = { appraise: () => Promise.resolve({ pleasure: 0.123, arousal: 0, dominance: 0 }) };
    const pull = await new LlmAppraiser({ provider, fallback: sentinel }).appraise(CTX);
    expect(pull.pleasure).toBe(0.123);
  });
});
