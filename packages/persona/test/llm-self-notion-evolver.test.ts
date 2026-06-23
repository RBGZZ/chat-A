import { describe, it, expect } from 'vitest';
import { FakeLlm } from '@chat-a/providers';
import { LlmSelfNotionEvolver, type SelfNotion } from '../src/index';

const NOTIONS: readonly SelfNotion[] = [
  { topic: ['咖啡', 'coffee'], position: '手冲比速溶值得。' },
  { topic: ['熬夜'], position: '熬夜伤身。' },
];

describe('LlmSelfNotionEvolver', () => {
  it('合规 JSON → 对应 topicKey 的正增量', async () => {
    const provider = new FakeLlm('fake', { complete: '强化:\n```json\n[{"i":0,"delta":0.05}]\n```' });
    const r = await new LlmSelfNotionEvolver({ provider }).evolve({ userText: '手冲确实更香', notions: NOTIONS, turn: 1 });
    expect(r).not.toBeNull();
    expect(r).toHaveLength(1);
    expect(r![0]?.delta).toBeCloseTo(0.05);
    expect(typeof r![0]?.topicKey).toBe('string');
  });

  it('非正增量/越界下标被丢弃', async () => {
    const provider = new FakeLlm('fake', { complete: '[{"i":0,"delta":-0.1},{"i":9,"delta":0.05}]' });
    const r = await new LlmSelfNotionEvolver({ provider }).evolve({ userText: 'x', notions: NOTIONS, turn: 1 });
    expect(r).toBeNull(); // 全部无效 → null
  });

  it('乱码 → null(降级)', async () => {
    const provider = new FakeLlm('fake', { complete: '我不会输出 JSON' });
    const r = await new LlmSelfNotionEvolver({ provider }).evolve({ userText: 'x', notions: NOTIONS, turn: 1 });
    expect(r).toBeNull();
  });

  it('空立场 → null(不调用)', async () => {
    const provider = new FakeLlm('fake', { complete: '[{"i":0,"delta":0.05}]' });
    const r = await new LlmSelfNotionEvolver({ provider }).evolve({ userText: 'x', notions: [], turn: 1 });
    expect(r).toBeNull();
  });
});
