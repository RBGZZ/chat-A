import { describe, it, expect } from 'vitest';
import {
  loadSttConfig,
  QWEN_DASHSCOPE_COMPAT_BASE_URL,
  QWEN_ASR_DEFAULT_MODEL,
} from '@chat-a/providers';

describe('loadSttConfig — DashScope qwen 便捷档(填 key 即用)', () => {
  it('CHAT_A_STT_KIND=qwen + DashScope key → openai-compat 档(model/baseURL/key 回落)', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'qwen',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
    });
    expect(cfg.kind).toBe('openai-compat');
    if (cfg.kind !== 'openai-compat') throw new Error('类型收窄');
    expect(cfg.id).toBe('qwen-asr');
    expect(cfg.model).toBe(QWEN_ASR_DEFAULT_MODEL);
    expect(cfg.baseURL).toBe(QWEN_DASHSCOPE_COMPAT_BASE_URL);
    expect(cfg.apiKey).toBe('sk-dash');
  });

  it('CHAT_A_STT_API_KEY 优先于 DashScope key', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'qwen',
      CHAT_A_STT_API_KEY: 'sk-explicit',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
    });
    if (cfg.kind !== 'openai-compat') throw new Error('类型收窄');
    expect(cfg.apiKey).toBe('sk-explicit');
  });

  it('CHAT_A_STT_MODEL / CHAT_A_STT_BASE_URL 覆盖默认', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'qwen',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_STT_MODEL: 'paraformer-x',
      CHAT_A_STT_BASE_URL: 'https://example.com/v1',
    });
    if (cfg.kind !== 'openai-compat') throw new Error('类型收窄');
    expect(cfg.model).toBe('paraformer-x');
    expect(cfg.baseURL).toBe('https://example.com/v1');
  });

  it('缺省(无 kind、无 key)→ 仍回落 fake(回归不破)', () => {
    expect(loadSttConfig({})).toEqual({ kind: 'fake' });
  });
});
