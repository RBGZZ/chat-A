import type { LlmProvider } from './llm';
import type { LlmConfig } from './config';
import { AnthropicLlm } from './anthropic-llm';
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

// ---- 内置厂商(新厂商照此注册即可)----
registerLlm('anthropic', (cfg) =>
  new AnthropicLlm({
    model: cfg.model,
    ...(cfg.apiKey !== undefined ? { apiKey: cfg.apiKey } : {}),
    ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
  }),
);
registerLlm('fake', (cfg) => new FakeLlm(cfg.model));
