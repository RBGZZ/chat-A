import type { Embedder } from './embedder';
import type { EmbedderConfig } from './embedder-config';
import { OpenAiCompatEmbedder } from './openai-compat-embedder';
import { HashEmbedder } from './hash-embedder';

/** 后端工厂:某一 kind 的子配置 → 具体 Embedder。 */
type EmbedderFactory<K extends EmbedderConfig['kind']> = (
  config: Extract<EmbedderConfig, { kind: K }>,
) => Embedder;

/**
 * 按判别联合 `kind` 索引的工厂表(承接缝 7 §5.7)。
 * 加新后端 = 加一个 kind 分支(config) + 在此登记工厂,**createEmbedder 核心零改动**、无 if/else 散落。
 */
const registry: { [K in EmbedderConfig['kind']]: EmbedderFactory<K> } = {
  'openai-compat': (cfg) =>
    new OpenAiCompatEmbedder({
      id: cfg.id ?? 'openai-compat',
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      dimension: cfg.dimension,
    }),
  hash: (cfg) =>
    new HashEmbedder({
      ...(cfg.dimension !== undefined ? { dimension: cfg.dimension } : {}),
    }),
};

export function listEmbedderKinds(): readonly EmbedderConfig['kind'][] {
  return Object.keys(registry) as EmbedderConfig['kind'][];
}

/**
 * 由配置解析具体 Embedder(零代码切换接缝)。
 * 判别联合保证类型收窄;未知 kind 在编译期即被排除,运行期再兜一道(防 JS 侧脏数据)。
 */
export function createEmbedder(config: EmbedderConfig): Embedder {
  const factory = registry[config.kind] as EmbedderFactory<EmbedderConfig['kind']> | undefined;
  if (factory === undefined) {
    throw new Error(
      `unknown embedder kind "${(config as { kind: string }).kind}"; registered: ${listEmbedderKinds().join(', ')}`,
    );
  }
  return factory(config);
}
