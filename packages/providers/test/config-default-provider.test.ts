import { describe, it, expect } from 'vitest';
import { loadLlmConfig } from '../src/index';

/**
 * 「填 key 即用」默认 provider 解析(companion-live-wiring,§3.2):
 * `CHAT_A_LLM_PROVIDER` 未显式设时——anthropic key → anthropic;否则 DashScope key → qwen;否则 fake。
 * 显式 provider / model / api key 优先;纯加法,既有分支行为不变。不触网(仅解析纯函数)。
 */
describe('providers/loadLlmConfig — 默认 provider「填 key 即用」', () => {
  it('仅填 DashScope key → 默认 qwen + qwen-plus + key 回落', () => {
    const cfg = loadLlmConfig({ CHAT_A_DASHSCOPE_API_KEY: 'sk-dash' });
    expect(cfg.provider).toBe('qwen');
    expect(cfg.model).toBe('qwen-plus');
    expect(cfg.apiKey).toBe('sk-dash');
  });

  it('无任何 key → 默认 fake(现有回落逐字不变)', () => {
    const cfg = loadLlmConfig({});
    expect(cfg.provider).toBe('fake');
    expect(cfg.model).toBe('fake-1');
    expect(cfg.apiKey).toBeUndefined();
  });

  it('anthropic key 存在 → 默认 anthropic(优先级高于 DashScope,现有不变)', () => {
    const cfg = loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-a' });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.apiKey).toBe('sk-a');
  });

  it('anthropic + DashScope 同在 → anthropic(向后兼容,DashScope 分支不介入)', () => {
    const cfg = loadLlmConfig({ ANTHROPIC_API_KEY: 'sk-a', CHAT_A_DASHSCOPE_API_KEY: 'sk-dash' });
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.apiKey).toBe('sk-a');
  });

  it('显式 CHAT_A_LLM_PROVIDER 优先(DashScope 分支不介入默认)', () => {
    const cfg = loadLlmConfig({ CHAT_A_LLM_PROVIDER: 'anthropic', CHAT_A_DASHSCOPE_API_KEY: 'sk-dash' });
    expect(cfg.provider).toBe('anthropic');
  });

  it('默认 qwen 时:显式 model / 通用 api key 覆盖默认与回落', () => {
    const cfg = loadLlmConfig({
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_LLM_MODEL: 'qwen-max',
      CHAT_A_LLM_API_KEY: 'sk-generic',
    });
    expect(cfg.provider).toBe('qwen');
    expect(cfg.model).toBe('qwen-max');
    expect(cfg.apiKey).toBe('sk-generic'); // 通用 key 优先于 DashScope 回落
  });

  it('空串 DashScope key 视为缺失 → 仍回落 fake', () => {
    const cfg = loadLlmConfig({ CHAT_A_DASHSCOPE_API_KEY: '' });
    expect(cfg.provider).toBe('fake');
  });

  it('显式 provider=qwen 且仅有 DashScope key → apiKey 回落到 DashScope', () => {
    const cfg = loadLlmConfig({ CHAT_A_LLM_PROVIDER: 'qwen', CHAT_A_DASHSCOPE_API_KEY: 'sk-dash' });
    expect(cfg.provider).toBe('qwen');
    expect(cfg.apiKey).toBe('sk-dash');
  });
});
