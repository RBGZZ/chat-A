import type { LlmProvider } from './llm';
import { FakeLlm } from './fake-llm';
import { AnthropicLlm } from './anthropic-llm';

export type LlmProviderId = 'anthropic' | 'fake';

export interface LlmConfig {
  readonly provider: LlmProviderId;
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/** 由配置构造 Provider(行为即配置,§3.2)。 */
export function createLlm(cfg: LlmConfig): LlmProvider {
  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicLlm({
        model: cfg.model,
        ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
        ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
      });
    case 'fake':
      return new FakeLlm(cfg.model);
    default: {
      const exhaustive: never = cfg.provider;
      throw new Error(`unknown LLM provider: ${String(exhaustive)}`);
    }
  }
}

/**
 * 从环境变量加载配置——用户自己选 provider/model:
 *   CHAT_A_LLM_PROVIDER = anthropic | fake
 *   CHAT_A_LLM_MODEL    = 模型串(默认 claude-opus-4-8)
 *   CHAT_A_LLM_MAX_TOKENS
 *   ANTHROPIC_API_KEY   = 有则默认 anthropic,无则默认 fake
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env['ANTHROPIC_API_KEY'];
  const hasKey = typeof apiKey === 'string' && apiKey.length > 0;
  const rawProvider = env['CHAT_A_LLM_PROVIDER'];
  const provider: LlmProviderId =
    rawProvider === 'anthropic' || rawProvider === 'fake' ? rawProvider : hasKey ? 'anthropic' : 'fake';
  const model = env['CHAT_A_LLM_MODEL'] ?? (provider === 'anthropic' ? 'claude-opus-4-8' : 'fake-1');
  const maxTokensRaw = env['CHAT_A_LLM_MAX_TOKENS'];

  return {
    provider,
    model,
    ...(hasKey ? { apiKey } : {}),
    ...(maxTokensRaw && Number.isFinite(Number(maxTokensRaw)) ? { maxTokens: Number(maxTokensRaw) } : {}),
  };
}
