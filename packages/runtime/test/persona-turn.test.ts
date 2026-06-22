import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type { Appraiser } from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/** 记录每轮传给 LLM 的 system。 */
function recordingLlm(): { llm: LlmProvider; systems: string[] } {
  const systems: string[] = [];
  const llm: LlmProvider = {
    id: 'rec',
    model: 'rec-1',
    async *stream(req) {
      systems.push(req.system);
      yield 'ok';
    },
  };
  return { llm, systems };
}

describe('runtime/persona: 情绪 tone 注入回合 system', () => {
  it('回合 system 含当轮 tone fragment', async () => {
    const { llm, systems } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1' });
    await convo.send('你好', () => {});
    expect(systems[0]).toContain('【当前情绪】');
  });

  it('心情差时 system 语气与心情好时不同(接缝级)', async () => {
    const negative: Appraiser = { appraise: () => ({ pleasure: -0.9, arousal: 0.3, dominance: 0 }) };
    const positive: Appraiser = { appraise: () => ({ pleasure: 0.9, arousal: 0.3, dominance: 0 }) };

    const neg = recordingLlm();
    const negConvo = new Conversation({ bus: new LightVoiceBus(), llm: neg.llm, appraiser: negative, sessionId: 'n' });
    const pos = recordingLlm();
    const posConvo = new Conversation({ bus: new LightVoiceBus(), llm: pos.llm, appraiser: positive, sessionId: 'p' });

    // 多轮把心情推到各自方向(越过冷启动窗口)。
    for (let i = 0; i < 8; i++) {
      await negConvo.send('随便说点', () => {});
      await posConvo.send('随便说点', () => {});
    }
    const lastNeg = neg.systems.at(-1) ?? '';
    const lastPos = pos.systems.at(-1) ?? '';
    expect(lastNeg).not.toBe(lastPos);
    expect(lastNeg).toMatch(/低落|烦躁/);
    expect(lastPos).toMatch(/心情很好|平和/);
  });
});
