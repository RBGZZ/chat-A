import { describe, it, expect } from 'vitest';
import { FakeLlm, createLlm, loadLlmConfig, registerLlm, listLlmProviders } from '../src/index';
import type { LlmProvider } from '../src/index';

async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const t of stream) out += t;
  return out;
}

describe('providers/FakeLlm', () => {
  it('流式回放引用用户最后一句的占位回复', async () => {
    const llm = new FakeLlm();
    const text = await collect(llm.stream({ system: 's', messages: [{ role: 'user', content: '你好' }] }));
    expect(text).toContain('你好');
    expect(text).toContain('FakeLLM');
    expect(llm.id).toBe('fake');
  });
});

describe('providers/config', () => {
  it('无 key 默认 fake;CHAT_A_LLM_PROVIDER/MODEL 可覆盖', () => {
    expect(loadLlmConfig({}).provider).toBe('fake');
    const a = loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-x' });
    expect(a.provider).toBe('anthropic');
    expect(a.model).toBe('claude-opus-4-8');
    const f = loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-x', CHAT_A_LLM_PROVIDER: 'fake' });
    expect(f.provider).toBe('fake');
    const m = loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-x', CHAT_A_LLM_MODEL: 'claude-sonnet-4-6' });
    expect(m.model).toBe('claude-sonnet-4-6');
  });
});

describe('providers/registry(开放扩展:加厂商不改核心)', () => {
  it('内置 anthropic / fake 已注册', () => {
    expect(listLlmProviders()).toContain('anthropic');
    expect(listLlmProviders()).toContain('fake');
  });

  it('createLlm(fake) 返回 FakeLlm', () => {
    expect(createLlm({ provider: 'fake', model: 'fake-1' }).id).toBe('fake');
  });

  it('注册自定义厂商后即可用,无需改 createLlm/系统', async () => {
    const echo: LlmProvider = {
      id: 'echo',
      model: 'echo-1',
      async *stream() {
        yield 'echo';
      },
      async complete() {
        return 'echo';
      },
    };
    registerLlm('echo', () => echo);
    const llm = createLlm({ provider: 'echo', model: 'echo-1' });
    expect(llm.id).toBe('echo');
    expect(await collect(llm.stream({ system: '', messages: [] }))).toBe('echo');
  });

  it('未知厂商抛错并列出已注册项', () => {
    expect(() => createLlm({ provider: 'nope', model: 'x' })).toThrow(/unknown LLM provider/);
  });
});
