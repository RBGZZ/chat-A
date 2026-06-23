import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type { Appraiser, PersonaSeed, StanceDetector } from '@chat-a/persona';
import { XIAOXUE_SEED } from '@chat-a/persona';
import type { MemoryExtractor } from '@chat-a/memory';
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
    async complete() {
      return 'ok';
    },
  };
  return { llm, systems };
}

const pull = (p: number): Appraiser => ({
  appraise: () => Promise.resolve({ pleasure: p, arousal: 0.3, dominance: 0 }),
});

describe('runtime/persona: 情绪 tone 注入回合 system', () => {
  it('回合 system 含当轮 tone fragment', async () => {
    const { llm, systems } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1' });
    await convo.send('你好', () => {});
    expect(systems[0]).toContain('【当前情绪】');
  });

  it('心情差时 system 语气与心情好时不同(接缝级;情绪滞后一轮)', async () => {
    const neg = recordingLlm();
    const negConvo = new Conversation({ bus: new LightVoiceBus(), llm: neg.llm, appraiser: pull(-0.9), sessionId: 'n' });
    const pos = recordingLlm();
    const posConvo = new Conversation({ bus: new LightVoiceBus(), llm: pos.llm, appraiser: pull(0.9), sessionId: 'p' });

    // 多轮把心情推到各自极端(越过冷启动窗口;advance 在回合后,故心情滞后一轮)。
    for (let i = 0; i < 12; i++) {
      await negConvo.send('随便说点', () => {});
      await posConvo.send('随便说点', () => {});
    }
    const lastNeg = neg.systems.at(-1) ?? '';
    const lastPos = pos.systems.at(-1) ?? '';
    expect(lastNeg).not.toBe(lastPos);
    expect(lastNeg).toMatch(/低落|烦躁/);
    expect(lastPos).toMatch(/心情很好|平和/);
  });

  it('注入命中观点的 StanceDetector → system 含异议段(§7#3)', async () => {
    const { llm, systems } = recordingLlm();
    // assertiveness 拉高,确保 DissentContributor 注入。
    const seed: PersonaSeed = {
      ...XIAOXUE_SEED,
      dials: { ...XIAOXUE_SEED.dials, assertiveness: 0.9 },
      selfNotions: [{ topic: ['咖啡'], position: '手冲比速溶值得。' }],
    };
    const detector: StanceDetector = {
      detect: () => Promise.resolve({ notions: [{ topic: ['咖啡'], position: '手冲比速溶值得。' }] }),
    };
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, personaSeed: seed, stanceDetector: detector, sessionId: 'd' });
    await convo.send('速溶咖啡更好', () => {});
    expect(systems[0]).toContain('[立场]');
    expect(systems[0]).toContain('手冲比速溶值得。');
  });

  it('StanceDetector 抛错 → 回合不中断、无观点段(§3.2 降级)', async () => {
    const { llm, systems } = recordingLlm();
    const seed: PersonaSeed = { ...XIAOXUE_SEED, dials: { ...XIAOXUE_SEED.dials, assertiveness: 0.9 } };
    const boom: StanceDetector = { detect: () => Promise.reject(new Error('stance boom')) };
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, personaSeed: seed, stanceDetector: boom, sessionId: 'sb' });
    const reply = await convo.send('你好', () => {});
    expect(reply).toBe('ok');
    // 降级:assertiveness 高 → 仍有反谄媚基线,但无具体观点段。
    expect(systems[0]).not.toContain('关于这些');
  });

  it('appraiser / extractor 抛错也不打断回合(§3.2)', async () => {
    const boomAppraiser: Appraiser = { appraise: () => Promise.reject(new Error('appraise boom')) };
    const boomExtractor: MemoryExtractor = { extract: () => Promise.reject(new Error('extract boom')) };
    const { llm } = recordingLlm();
    const bus = new LightVoiceBus();
    const actions: string[] = [];
    bus.onAny((e) => actions.push(e.action));
    const convo = new Conversation({
      bus,
      llm,
      appraiser: boomAppraiser,
      memoryExtractor: boomExtractor,
      sessionId: 'b',
    });
    const reply = await convo.send('你好', () => {});
    expect(reply).toBe('ok');
    expect(actions).toContain('turn:end');
  });
});
