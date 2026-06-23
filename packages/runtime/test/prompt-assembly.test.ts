import { describe, it, expect } from 'vitest';
import type { LlmProvider } from '@chat-a/providers';
import type { MemoryRecord } from '@chat-a/memory';
import { buildSystemPrompt } from '@chat-a/cognition';
import { LightVoiceBus } from '../src/bus';
import { Conversation } from '../src/conversation';

/** 记录每轮传给 LLM 的 system / messages(验等价契约)。 */
function recordingLlm(): { llm: LlmProvider; systems: string[]; messages: { role: string; content: string }[][] } {
  const systems: string[] = [];
  const messages: { role: string; content: string }[][] = [];
  const llm: LlmProvider = {
    id: 'rec',
    model: 'rec-1',
    async *stream(req) {
      systems.push(req.system);
      messages.push(req.messages.map((m) => ({ role: m.role, content: m.content })));
      yield 'ok';
    },
    async complete() {
      return 'ok';
    },
  };
  return { llm, systems, messages };
}

/** 旧 #composeSystem 三段拼接基线(逐字搬运重构前逻辑)。 */
function legacyComposeSystem(skeleton: string, recalled: readonly MemoryRecord[], toneFragment: string): string {
  const parts = [skeleton];
  if (recalled.length > 0) {
    parts.push(`[与当前输入相关的记忆]\n${recalled.map((r) => `- ${r.text}`).join('\n')}`);
  }
  parts.push(toneFragment);
  return parts.join('\n\n');
}

describe('runtime/Conversation 接入 PromptAssembler 对外等价(§5.4)', () => {
  it('5.1 默认无召回:Conversation 的 system = 旧三段拼接(骨架 + tone)', async () => {
    const { llm, systems, messages } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1' });
    await convo.send('你好小雪', () => {});

    const skeleton = buildSystemPrompt();
    const first = systems[0]!;
    // tone 段以【当前情绪】打头;无召回 → 段序 = 骨架 \n\n tone。
    expect(first.startsWith(`${skeleton}\n\n`)).toBe(true);
    expect(first).toContain('【当前情绪】');
    expect(first).not.toContain('[与当前输入相关的记忆]');
    // messages 首轮 = [当轮 userMsg](snapshot 此刻为空);volatile 默认空 → 原文。
    expect(messages[0]).toEqual([{ role: 'user', content: '你好小雪' }]);
  });

  it('5.1 第二轮带历史:messages = [...snapshot, userMsg](结构与旧实现一致)', async () => {
    const { llm, messages } = recordingLlm();
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1' });
    await convo.send('一', () => {});
    await convo.send('二', () => {});
    // 第二轮 messages 末条为当轮 userMsg,且含上一轮落库的 user/assistant 历史。
    const second = messages[1]!;
    expect(second.at(-1)).toEqual({ role: 'user', content: '二' });
    expect(second.some((m) => m.content === '一')).toBe(true);
    expect(second.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true);
  });

  it('5.1 召回命中:system 段序 骨架→记忆→tone,记忆块字面与旧实现一致', async () => {
    const { llm, systems } = recordingLlm();
    // 注入会召回的记忆:先存一条,再用同关键词召回。
    const convo = new Conversation({ bus: new LightVoiceBus(), llm, sessionId: 's1' });
    await convo.send('我喜欢猫', () => {}); // naive 存用户原话
    await convo.send('猫', () => {}); // 关键词召回上一条
    const last = systems.at(-1)!;
    if (last.includes('[与当前输入相关的记忆]')) {
      const parts = last.split('\n\n');
      expect(parts[0]).toBe(buildSystemPrompt());
      expect(parts[1]).toContain('[与当前输入相关的记忆]');
      expect(parts[1]).toContain('- 我喜欢猫');
      // 段序 骨架→记忆→tone→异议(默认 assertiveness=0.5 追加温和反谄媚基线,§7#3)。
      expect(last).toContain('【当前情绪】');
      const toneIdx = parts.findIndex((p) => p.includes('【当前情绪】'));
      const dissentIdx = parts.findIndex((p) => p.includes('[立场]'));
      expect(toneIdx).toBeGreaterThan(1);
      expect(dissentIdx).toBeGreaterThan(toneIdx); // 异议在 tone 之后
    }
  });
});
