import type { SttProvider } from './stt';
import type { SttConfig } from './stt-config';
import { FakeStt } from './fake-stt';
import { OpenAiCompatStt } from './openai-compat-stt';

/** 后端工厂:某一 kind 的子配置 → 具体 SttProvider。 */
type SttFactory<K extends SttConfig['kind']> = (config: Extract<SttConfig, { kind: K }>) => SttProvider;

/**
 * 按判别联合 `kind` 索引的工厂表(承 §4.3 语音 Provider 可换性;镜像 embedder-registry)。
 * 加新引擎 = 加一个 kind 分支(config) + 在此登记工厂,**createStt 核心零改动**、无 if/else 散落。
 */
const registry: { [K in SttConfig['kind']]: SttFactory<K> } = {
  fake: (cfg) =>
    new FakeStt({
      ...(cfg.languages !== undefined ? { capabilities: { languages: cfg.languages } } : {}),
    }),
  'openai-compat': (cfg) =>
    new OpenAiCompatStt({
      id: cfg.id ?? 'openai-compat',
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      ...(cfg.language !== undefined ? { language: cfg.language } : {}),
      ...(cfg.responseFormat !== undefined ? { responseFormat: cfg.responseFormat } : {}),
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
    }),
  // 本地引擎(faster-whisper / whisper.cpp / sherpa-onnx):配置接缝已就位,真实绑定以后接(§4.3)。
  'whisper-local': (cfg) => {
    throw new Error(
      `whisper-local STT 尚未接入真实引擎(faster-whisper/whisper.cpp/sherpa-onnx);config 已就位:model=${cfg.model}`,
    );
  },
};

export function listSttKinds(): readonly SttConfig['kind'][] {
  return Object.keys(registry) as SttConfig['kind'][];
}

/**
 * 由配置解析具体 SttProvider(零代码切换接缝)。
 * 判别联合保证类型收窄;未知 kind 编译期排除,运行期再兜一道(防 JS 侧脏数据)。
 */
export function createStt(config: SttConfig): SttProvider {
  const factory = registry[config.kind] as SttFactory<SttConfig['kind']> | undefined;
  if (factory === undefined) {
    throw new Error(
      `unknown STT kind "${(config as { kind: string }).kind}"; registered: ${listSttKinds().join(', ')}`,
    );
  }
  return factory(config);
}
