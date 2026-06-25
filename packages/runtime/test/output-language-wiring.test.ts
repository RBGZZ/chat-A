import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/**
 * §4.1 输出语种注入回合 system:Conversation 注入 outputLang → 系统提示含目标回复语种段;
 * **未注入 → 不含(逐字现状,回归绿)。**
 */
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

describe('runtime/Conversation §4.1 输出语种注入', () => {
  it('注入 outputLang → system 含目标语种段', async () => {
    const { llm, systems } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1', outputLang: 'ja' });
    await convo.send('hello', () => {});
    expect(systems[0]).toContain('回复语种');
    expect(systems[0]).toContain('日语'); // ja → 日语(码映射为语言名)
  });

  it('未注入 outputLang → system 不含输出语种段(回归绿)', async () => {
    const { llm, systems } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's2' });
    await convo.send('hello', () => {});
    expect(systems[0]).not.toContain('回复语种');
  });
});
