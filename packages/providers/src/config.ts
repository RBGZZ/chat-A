import type { Device, ComputeType } from './hardware';

/**
 * LLM 配置(行为即配置,§3.2)。`provider` 为**开放字符串**——加新厂商无需改此类型。
 * 由 createLlm(registry)解析为具体实现;系统其余部分对厂商/模型无感。
 */
export interface LlmConfig {
  readonly provider: string;
  readonly model: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  /**
   * OpenAI 兼容端点根覆盖(行为即配置,§3.2)。纯加法可选——缺省时各厂商用各自内置默认
   * (deepseek→api.deepseek.com、qwen→DashScope 兼容端点),行为不变;提供时由 createLlm 透传给工厂。
   */
  readonly baseURL?: string;
  /**
   * 设备(端侧本地 LLM 如 rkllama/llama.cpp 据此选 CPU/GPU;共享 {@link Device},§5.10 C1/C2)。
   * 纯加法、省略时行为不变(云端厂商忽略此位)。
   */
  readonly device?: Device;
  /** 计算精度 / 量化档(端侧本地 LLM 用;共享 {@link ComputeType},绑 profile 非 backend,§5.10 C1)。 */
  readonly computeType?: ComputeType;
  /** 是否要求 CUDA(能力位,§4.3 能力门 / §5.6;缺省视为不要求)。 */
  readonly requiresCuda?: boolean;
}

/**
 * 从环境变量加载——用户自己选 provider/model:
 *   CHAT_A_LLM_PROVIDER = anthropic | deepseek | fake | <已注册的任意厂商>
 *   CHAT_A_LLM_MODEL    = 模型串(默认 anthropic→claude-opus-4-8)
 *   CHAT_A_LLM_API_KEY  = 通用 API key(任意厂商),回落到 ANTHROPIC_API_KEY
 *   CHAT_A_LLM_MAX_TOKENS
 *   CHAT_A_LLM_BASE_URL = OpenAI 兼容端点根覆盖(可选;缺省用厂商默认,如自托管/代理)
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

  // base URL 覆盖:仅非空时携带(适配 exactOptionalPropertyTypes,缺省走厂商默认)。
  const baseURLRaw = env['CHAT_A_LLM_BASE_URL'];
  const baseURL = typeof baseURLRaw === 'string' && baseURLRaw.length > 0 ? baseURLRaw : undefined;

  return {
    provider,
    model,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(maxTokensRaw && Number.isFinite(Number(maxTokensRaw)) ? { maxTokens: Number(maxTokensRaw) } : {}),
    ...(baseURL !== undefined ? { baseURL } : {}),
  };
}
