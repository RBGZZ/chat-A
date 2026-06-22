/**
 * LLM 配置(行为即配置,§3.2)。`provider` 为**开放字符串**——加新厂商无需改此类型。
 * 由 createLlm(registry)解析为具体实现;系统其余部分对厂商/模型无感。
 */
export interface LlmConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
}

/**
 * 从环境变量加载——用户自己选 provider/model:
 *   CHAT_A_LLM_PROVIDER = anthropic | deepseek | fake | <已注册的任意厂商>
 *   CHAT_A_LLM_MODEL    = 模型串(默认 anthropic→claude-opus-4-8)
 *   CHAT_A_LLM_API_KEY  = 通用 API key(任意厂商),回落到 ANTHROPIC_API_KEY
 *   CHAT_A_LLM_MAX_TOKENS
 *   ANTHROPIC_API_KEY   = 有则默认 anthropic,无则默认 fake
 */
export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const anthropicKey = env['ANTHROPIC_API_KEY'];
  const hasAnthropicKey = typeof anthropicKey === 'string' && anthropicKey.length > 0;
  const provider = env['CHAT_A_LLM_PROVIDER'] ?? (hasAnthropicKey ? 'anthropic' : 'fake');

  // API key:通用 CHAT_A_LLM_API_KEY 优先(任意厂商),否则回落到 ANTHROPIC_API_KEY。
  const genericKey = env['CHAT_A_LLM_API_KEY'];
  const apiKey =
    typeof genericKey === 'string' && genericKey.length > 0
      ? genericKey
      : hasAnthropicKey
        ? anthropicKey
        : undefined;

  const model =
    env['CHAT_A_LLM_MODEL'] ?? (provider === 'anthropic' ? 'claude-opus-4-8' : provider === 'fake' ? 'fake-1' : '');
  const maxTokensRaw = env['CHAT_A_LLM_MAX_TOKENS'];

  return {
    provider,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(maxTokensRaw && Number.isFinite(Number(maxTokensRaw)) ? { maxTokens: Number(maxTokensRaw) } : {}),
  };
}
