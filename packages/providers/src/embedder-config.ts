/**
 * Embedder 配置(行为即配置,§3.2;接缝 7 §5.7)。
 *
 * **判别联合**(discriminated union):`kind` 字段决定形状 → 工厂零 if/else 散落、零代码切换
 * (这是调研列为"最高优先级抄"的 Factory + discriminated-union 接缝)。
 * 加新后端 = 加一个分支 + 在 registry 注册,**系统其余部分与 createEmbedder 核心零改动**。
 */
import type { Device, ComputeType } from './hardware';

export type EmbedderConfig =
  | OpenAiCompatEmbedderConfig
  | HashEmbedderConfig;

/** OpenAI 兼容 embedding 服务(云端 OpenAI / 本地 BGE-M3 / Qwen3-Embedding 等 OpenAI 协议端点)。 */
export interface OpenAiCompatEmbedderConfig {
  readonly kind: 'openai-compat';
  /** trace 标识(如 'openai' / 'bge-m3');缺省回落到 kind。 */
  readonly id?: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseURL: string;
  /** 目标维度(能力声明位,§5.7)。 */
  readonly dimension: number;
  /**
   * 设备(本地 embedding 服务如 BGE-M3/FastEmbed 据此选 CPU/GPU;共享 {@link Device},§5.10 C1)。
   * 纯加法、省略时行为不变(云端 OpenAI 端点忽略此位)。
   */
  readonly device?: Device;
  /** 计算精度 / 量化档(本地 embedding 服务用;共享 {@link ComputeType},绑 profile 非 backend,§5.10 C1)。 */
  readonly computeType?: ComputeType;
  /** 是否要求 CUDA(能力位,§4.3 能力门 / §5.6;缺省视为不要求)。 */
  readonly requiresCuda?: boolean;
}

/** 确定性 Hash 兜底(无依赖、可复现;§5.7 "Hash 仅离线兜底")。 */
export interface HashEmbedderConfig {
  readonly kind: 'hash';
  /** 维度可配(默认见 HashEmbedder)。 */
  readonly dimension?: number;
}

/**
 * 从环境变量加载——用户自己选 embedder 后端:
 *   CHAT_A_EMBEDDER_KIND       = openai-compat | hash(默认:有 base URL+key+model 则 openai-compat,否则 hash)
 *   CHAT_A_EMBEDDER_MODEL      = 模型串(openai-compat 用)
 *   CHAT_A_EMBEDDER_API_KEY    = API key(openai-compat 用)
 *   CHAT_A_EMBEDDER_BASE_URL   = OpenAI 兼容端点根
 *   CHAT_A_EMBEDDER_DIMENSION  = 维度(openai-compat 必填;hash 可选,默认 384)
 *
 * 缺关键项时**自动降级**到 Hash(承 §5.7 离线兜底):保证无配置也能跑通,不阻塞开发/测试。
 */
export function loadEmbedderConfig(env: NodeJS.ProcessEnv = process.env): EmbedderConfig {
  const kind = env['CHAT_A_EMBEDDER_KIND'];
  const model = env['CHAT_A_EMBEDDER_MODEL'];
  const apiKey = env['CHAT_A_EMBEDDER_API_KEY'];
  const baseURL = env['CHAT_A_EMBEDDER_BASE_URL'];
  const dimRaw = env['CHAT_A_EMBEDDER_DIMENSION'];
  const dim = dimRaw && Number.isFinite(Number(dimRaw)) ? Number(dimRaw) : undefined;

  const hasOpenAi =
    typeof model === 'string' &&
    model.length > 0 &&
    typeof apiKey === 'string' &&
    apiKey.length > 0 &&
    typeof baseURL === 'string' &&
    baseURL.length > 0 &&
    dim !== undefined;

  // 显式选 openai-compat 但缺项 → 让工厂/构造在校验处明确报错,而非静默吞配置。
  const resolved = kind ?? (hasOpenAi ? 'openai-compat' : 'hash');

  if (resolved === 'openai-compat') {
    return {
      kind: 'openai-compat',
      model: model ?? '',
      apiKey: apiKey ?? '',
      baseURL: baseURL ?? '',
      dimension: dim ?? 0,
      ...(env['CHAT_A_EMBEDDER_ID'] ? { id: env['CHAT_A_EMBEDDER_ID'] } : {}),
    };
  }

  return {
    kind: 'hash',
    ...(dim !== undefined ? { dimension: dim } : {}),
  };
}
