import { describe, it, expect } from 'vitest';
import {
  createLlm,
  loadLlmConfig,
  listLlmProviders,
  OpenAiCompatLlm,
  QWEN_DASHSCOPE_BASE_URL,
} from '../src/index';

describe('providers/registry(qwen DashScope 纯文本)', () => {
  it('qwen 已登记于注册表', () => {
    expect(listLlmProviders()).toContain('qwen');
  });

  it('createLlm(qwen) 返回 OpenAiCompatLlm,id=qwen,baseURL=DashScope 兼容端点', () => {
    const llm = createLlm({ provider: 'qwen', model: 'qwen-plus', apiKey: 'sk-x' });
    expect(llm).toBeInstanceOf(OpenAiCompatLlm);
    expect(llm.id).toBe('qwen');
    expect(llm.model).toBe('qwen-plus');
    expect((llm as OpenAiCompatLlm).baseURL).toBe(QWEN_DASHSCOPE_BASE_URL);
  });

  it('缺 apiKey 抛清晰错误(提示设 key)', () => {
    expect(() => createLlm({ provider: 'qwen', model: 'qwen-plus' })).toThrow(/qwen/);
    expect(() => createLlm({ provider: 'qwen', model: 'qwen-plus' })).toThrow(/API key|CHAT_A_LLM_API_KEY|DASHSCOPE/);
    // 空串同样视为缺失
    expect(() => createLlm({ provider: 'qwen', model: 'qwen-plus', apiKey: '' })).toThrow(/API key|CHAT_A_LLM_API_KEY|DASHSCOPE/);
  });

  it('baseURL 可覆盖(去尾随斜杠)', () => {
    const llm = createLlm({
      provider: 'qwen',
      model: 'qwen-plus',
      apiKey: 'sk-x',
      baseURL: 'https://x.example/v1/',
    });
    expect((llm as OpenAiCompatLlm).baseURL).toBe('https://x.example/v1');
  });
});

describe('providers/config(qwen + baseURL 覆盖)', () => {
  it('CHAT_A_LLM_PROVIDER=qwen 解析正确', () => {
    const cfg = loadLlmConfig({
      CHAT_A_LLM_PROVIDER: 'qwen',
      CHAT_A_LLM_MODEL: 'qwen-plus',
      CHAT_A_LLM_API_KEY: 'sk-x',
    });
    expect(cfg.provider).toBe('qwen');
    expect(cfg.model).toBe('qwen-plus');
    expect(cfg.apiKey).toBe('sk-x');
    // 不带 base URL 覆盖时,config 不应携带 baseURL 字段
    expect(cfg.baseURL).toBeUndefined();
  });

  it('CHAT_A_LLM_BASE_URL 覆盖落到 config.baseURL', () => {
    const cfg = loadLlmConfig({
      CHAT_A_LLM_PROVIDER: 'qwen',
      CHAT_A_LLM_MODEL: 'qwen-plus',
      CHAT_A_LLM_API_KEY: 'sk-x',
      CHAT_A_LLM_BASE_URL: 'https://self-hosted/v1',
    });
    expect(cfg.baseURL).toBe('https://self-hosted/v1');
  });

  it('config.baseURL 经 createLlm 注入 qwen 实例', () => {
    const cfg = loadLlmConfig({
      CHAT_A_LLM_PROVIDER: 'qwen',
      CHAT_A_LLM_MODEL: 'qwen-plus',
      CHAT_A_LLM_API_KEY: 'sk-x',
      CHAT_A_LLM_BASE_URL: 'https://self-hosted/v1',
    });
    const llm = createLlm(cfg);
    expect((llm as OpenAiCompatLlm).baseURL).toBe('https://self-hosted/v1');
  });
});

describe('providers/OpenAiCompatLlm.baseURL 只读暴露', () => {
  it('baseURL 去尾随斜杠,fetch 行为不变(纯加法)', () => {
    const llm = new OpenAiCompatLlm({
      id: 'qwen',
      model: 'qwen-plus',
      apiKey: 'sk-x',
      baseURL: 'https://x.example/v1//',
    });
    expect(llm.baseURL).toBe('https://x.example/v1');
    expect(llm.supportsTools).toBe(true);
  });
});
