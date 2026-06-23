import type { TtsProvider } from './tts';
import type { TtsConfig } from './tts-config';
import { FakeTts } from './fake-tts';
import { OpenAiCompatTts } from './openai-compat-tts';

/** 后端工厂:某一 kind 的子配置 → 具体 TtsProvider。 */
type TtsFactory<K extends TtsConfig['kind']> = (config: Extract<TtsConfig, { kind: K }>) => TtsProvider;

/**
 * 按判别联合 `kind` 索引的工厂表(承 §4.3 + 音色复刻 §4.1/v2.1;镜像 embedder-registry)。
 * 加新引擎 = 加一个 kind 分支 + 在此登记工厂,**createTts 核心零改动**。
 */
const registry: { [K in TtsConfig['kind']]: TtsFactory<K> } = {
  fake: (cfg) =>
    new FakeTts({
      capabilities: {
        ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
        ...(cfg.voiceCloning !== undefined ? { voiceCloning: cfg.voiceCloning } : {}),
      },
    }),
  'openai-compat': (cfg) =>
    new OpenAiCompatTts({
      id: cfg.id ?? 'openai-compat',
      model: cfg.model,
      apiKey: cfg.apiKey,
      baseURL: cfg.baseURL,
      voice: cfg.voice,
      ...(cfg.responseFormat !== undefined ? { responseFormat: cfg.responseFormat } : {}),
      ...(cfg.speed !== undefined ? { speed: cfg.speed } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
    }),
  // 以下引擎配置接缝已就位,真实绑定以后接(§4.3);各自能力(复刻/采样率)在 config 已声明。
  edge: (cfg) => {
    throw new Error(`edge TTS 尚未接入真实引擎(Edge-TTS);config 已就位:voice=${cfg.voice}`);
  },
  kokoro: (cfg) => {
    throw new Error(`kokoro TTS 尚未接入真实引擎;config 已就位:voice=${cfg.voice}`);
  },
  'gpt-sovits': (cfg) => {
    throw new Error(
      `gpt-sovits TTS(zero-shot 复刻)尚未接入真实引擎;config 已就位:baseURL=${cfg.baseURL}`,
    );
  },
};

export function listTtsKinds(): readonly TtsConfig['kind'][] {
  return Object.keys(registry) as TtsConfig['kind'][];
}

/**
 * 由配置解析具体 TtsProvider(零代码切换接缝)。
 * 判别联合保证类型收窄;未知 kind 编译期排除,运行期再兜一道。
 */
export function createTts(config: TtsConfig): TtsProvider {
  const factory = registry[config.kind] as TtsFactory<TtsConfig['kind']> | undefined;
  if (factory === undefined) {
    throw new Error(
      `unknown TTS kind "${(config as { kind: string }).kind}"; registered: ${listTtsKinds().join(', ')}`,
    );
  }
  return factory(config);
}
