import type { LlmProvider } from './llm';
import type { LlmConfig } from './config';
import { AnthropicLlm } from './anthropic-llm';
import { OpenAiCompatLlm } from './openai-compat-llm';
import { FakeLlm } from './fake-llm';

/** 厂商工厂:配置 → 具体 Provider。 */
export type LlmFactory = (config: LlmConfig) => LlmProvider;

const registry = new Map<string, LlmFactory>();

/**
 * 注册一个厂商工厂(开放扩展,承 §3.1)。
 * 加新厂商/模型来源 = 在此 registerLlm,**系统其余部分与 createLlm 核心零改动**。
 */
export function registerLlm(provider: string, factory: LlmFactory): void {
  registry.set(provider, factory);
}

export function listLlmProviders(): readonly string[] {
  return [...registry.keys()];
}

/** 由配置解析具体 Provider;未知厂商抛错并列出已注册项。 */
export function createLlm(config: LlmConfig): LlmProvider {
  const factory = registry.get(config.provider);
  if (factory === undefined) {
    throw new Error(
      `unknown LLM provider "${config.provider}"; registered: ${listLlmProviders().join(', ') || '(none)'}`,
    );
  }
  return factory(config);
}

// ---- OpenAI 兼容厂商默认端点(无 magic number;可经 CHAT_A_LLM_BASE_URL / LlmConfig.baseURL 覆盖)----
/** DeepSeek 默认端点根。 */
export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
/** 通义千问(阿里 DashScope)OpenAI 兼容端点根(纯文本 chat/completions + SSE,§3.3)。 */
export const QWEN_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/**
 * 通义千问 Omni Realtime WebSocket 端点根(OpenAI-Realtime 风格,audio-in → 文本流)。
 * 供 `QwenOmniLlm`(纯音频面,不在本 LLM registry)与其测试使用;路径B 接 VoiceLoop 时再装配。
 */
export const QWEN_DASHSCOPE_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';

// ---- 内置厂商(新厂商照此注册即可)----
registerLlm('anthropic', (cfg) =>
  new AnthropicLlm({
    model: cfg.model,
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
  }),
);
registerLlm('deepseek', (cfg) => {
  if (cfg.apiKey === undefined || cfg.apiKey.length === 0) {
    throw new Error('deepseek 需要 API key(设 CHAT_A_LLM_API_KEY)');
  }
  return new OpenAiCompatLlm({
    id: 'deepseek',
    model: cfg.model,
    apiKey: cfg.apiKey,
    // 默认 DeepSeek 端点;配置提供 baseURL 时覆盖(自托管/代理),缺省行为不变。
    baseURL: cfg.baseURL ?? DEEPSEEK_BASE_URL,
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
  });
});
// 通义千问(DashScope)纯文本:复用 OpenAiCompatLlm(§3.3),镜像 deepseek 分支。
// 纯文本路径(qwen-plus / qwen3 等)。多模态 audio-in 见 QwenOmniLlm(纯音频面,不作 LLM provider 注册;
// 因 DashScope realtime 不支持纯文本 item 输入,文本一律走本 'qwen' provider)。
registerLlm('qwen', (cfg) => {
  if (cfg.apiKey === undefined || cfg.apiKey.length === 0) {
    throw new Error('qwen 需要 API key(设 CHAT_A_LLM_API_KEY,即阿里云 DASHSCOPE_API_KEY)');
  }
  return new OpenAiCompatLlm({
    id: 'qwen',
    model: cfg.model,
    apiKey: cfg.apiKey,
    // 默认 DashScope 兼容端点;配置提供 baseURL 时覆盖(自托管/代理),缺省行为不变。
    baseURL: cfg.baseURL ?? QWEN_DASHSCOPE_BASE_URL,
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
  });
});
registerLlm('fake', (cfg) => new FakeLlm(cfg.model));
