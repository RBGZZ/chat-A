import type { TtsProvider } from './tts';
import type { TtsConfig } from './tts-config';
import { FakeTts } from './fake-tts';
import { OpenAiCompatTts } from './openai-compat-tts';
import { KokoroTts } from './kokoro-tts';
import type { KokoroSession } from './kokoro-tts';
import { QwenTtsRealtime } from './qwen-tts-realtime';
import type { QwenWsFactory } from './qwen-tts-realtime';
import { GptSoVitsTts } from './gpt-sovits-tts';
import type { FetchLike } from './gpt-sovits-tts';
import { CosyVoiceTts } from './cosyvoice-tts';
import type { CosyVoiceWsFactory } from './cosyvoice-tts';

/**
 * 运行时注入的 TTS 端口(R1 注入式接缝)。
 * worktree 不装 onnxruntime/模型,真引擎经此端口由运行时注入;省略则相应 kind 明确报错(非崩)。
 */
export interface TtsPorts {
  /** kokoro 的推理 session 端口;运行时包一层 onnxruntime-node / kokoro-js。 */
  readonly kokoroSession?: KokoroSession;
  /**
   * qwen-tts 的 WebSocket 工厂端口(可测性接缝);
   * 缺省时 QwenTtsRealtime 懒加载 `ws` 包建真连接,测试经此注入 mock WS(不触网)。
   */
  readonly qwenWsFactory?: QwenWsFactory;
  /**
   * gpt-sovits 的 fetch 注入端口(可测性接缝,镜像 qwenWsFactory);
   * 缺省时 GptSoVitsTts 用 `globalThis.fetch` 走真网络,测试经此注入 mock fetch(不触网)。
   */
  readonly fetch?: FetchLike;
  /**
   * cosyvoice 的 WebSocket 工厂端口(可测性接缝);
   * 缺省时 CosyVoiceTts 懒加载 `ws` 包建真连接,测试经此注入 mock WS(不触网)。
   */
  readonly cosyVoiceWsFactory?: CosyVoiceWsFactory;
}

/** 后端工厂:某一 kind 的子配置(+ 注入端口) → 具体 TtsProvider。 */
type TtsFactory<K extends TtsConfig['kind']> = (
  config: Extract<TtsConfig, { kind: K }>,
  ports: TtsPorts,
) => TtsProvider;

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
  // kokoro:注入了推理 session 端口才建真适配,否则明确报错"需运行时端口"
  // (非"尚未接入"——接缝已就位,缺的是运行时注入,§4.3 R1)。
  kokoro: (cfg, ports) => {
    if (ports.kokoroSession === undefined) {
      throw new Error(
        `kokoro TTS 需运行时提供 session 端口(TtsPorts.kokoroSession);config 已就位:voice=${cfg.voice}。` +
          `请用 createTts(config, { kokoroSession }) 注入(运行时包 onnxruntime-node / kokoro-js)。`,
      );
    }
    return new KokoroTts({
      id: cfg.id ?? 'kokoro',
      voice: cfg.voice,
      session: ports.kokoroSession,
      ...(cfg.speed !== undefined ? { speed: cfg.speed } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.device !== undefined ? { device: cfg.device } : {}),
      ...(cfg.computeType !== undefined ? { computeType: cfg.computeType } : {}),
      ...(cfg.requiresCuda !== undefined ? { requiresCuda: cfg.requiresCuda } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
    });
  },
  // gpt-sovits:本地 zero-shot 音色复刻,HTTP /tts 流式裸 PCM。
  // fetch 端口可注入(测试 mock,不触网);缺省时 GptSoVitsTts 用 globalThis.fetch。
  'gpt-sovits': (cfg, ports) =>
    new GptSoVitsTts({
      id: cfg.id ?? 'gpt-sovits',
      baseURL: cfg.baseURL,
      ...(cfg.textLang !== undefined ? { textLang: cfg.textLang } : {}),
      ...(cfg.refAudioPath !== undefined ? { refAudioPath: cfg.refAudioPath } : {}),
      ...(cfg.promptText !== undefined ? { promptText: cfg.promptText } : {}),
      ...(cfg.promptLang !== undefined ? { promptLang: cfg.promptLang } : {}),
      ...(cfg.textSplitMethod !== undefined ? { textSplitMethod: cfg.textSplitMethod } : {}),
      ...(cfg.stream !== undefined ? { stream: cfg.stream } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.voiceId !== undefined ? { voiceId: cfg.voiceId } : {}),
      ...(cfg.requiresCuda !== undefined ? { requiresCuda: cfg.requiresCuda } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
      ...(ports.fetch !== undefined ? { fetch: ports.fetch } : {}),
    }),
  // qwen-tts:DashScope WebSocket 流式 TTS。缺 apiKey → 构造内 fail-fast(明确报错)。
  // wsFactory 端口可注入(测试 mock WS);缺省时懒加载 `ws` 建真连接。
  'qwen-tts': (cfg, ports) =>
    new QwenTtsRealtime({
      id: cfg.id ?? 'qwen-tts',
      model: cfg.model,
      apiKey: cfg.apiKey,
      voice: cfg.voice,
      ...(cfg.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.responseFormat !== undefined ? { responseFormat: cfg.responseFormat } : {}),
      ...(cfg.mode !== undefined ? { mode: cfg.mode } : {}),
      ...(cfg.instructions !== undefined ? { instructions: cfg.instructions } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
      ...(cfg.voiceCloning !== undefined ? { voiceCloning: cfg.voiceCloning } : {}),
      ...(ports.qwenWsFactory !== undefined ? { wsFactory: ports.qwenWsFactory } : {}),
    }),
  // cosyvoice:DashScope run-task WS 流式 TTS(二进制裸 PCM 帧)。缺 apiKey → 构造内 fail-fast。
  // wsFactory 端口可注入(测试 mock WS);缺省时懒加载 `ws` 建真连接。
  cosyvoice: (cfg, ports) =>
    new CosyVoiceTts({
      id: cfg.id ?? 'cosyvoice',
      apiKey: cfg.apiKey,
      ...(cfg.model !== undefined ? { model: cfg.model } : {}),
      ...(cfg.voice !== undefined ? { voice: cfg.voice } : {}),
      ...(cfg.endpoint !== undefined ? { endpoint: cfg.endpoint } : {}),
      ...(cfg.format !== undefined ? { format: cfg.format } : {}),
      ...(cfg.sampleRate !== undefined ? { sampleRate: cfg.sampleRate } : {}),
      ...(cfg.rate !== undefined ? { rate: cfg.rate } : {}),
      ...(cfg.pitch !== undefined ? { pitch: cfg.pitch } : {}),
      ...(cfg.volume !== undefined ? { volume: cfg.volume } : {}),
      ...(cfg.instruction !== undefined ? { instruction: cfg.instruction } : {}),
      ...(cfg.enableSsml !== undefined ? { enableSsml: cfg.enableSsml } : {}),
      ...(cfg.languages !== undefined ? { languages: cfg.languages } : {}),
      ...(ports.cosyVoiceWsFactory !== undefined ? { wsFactory: ports.cosyVoiceWsFactory } : {}),
    }),
};

export function listTtsKinds(): readonly TtsConfig['kind'][] {
  return Object.keys(registry) as TtsConfig['kind'][];
}

/**
 * 由配置解析具体 TtsProvider(零代码切换接缝)。
 * 判别联合保证类型收窄;未知 kind 编译期排除,运行期再兜一道。
 *
 * `ports`(可选)注入运行时端口:本地引擎(kokoro)经此拿到真 session;
 * 未注入时该 kind 明确报错(非崩),云端/fake 不受影响。
 */
export function createTts(config: TtsConfig, ports: TtsPorts = {}): TtsProvider {
  const factory = registry[config.kind] as TtsFactory<TtsConfig['kind']> | undefined;
  if (factory === undefined) {
    throw new Error(
      `unknown TTS kind "${(config as { kind: string }).kind}"; registered: ${listTtsKinds().join(', ')}`,
    );
  }
  return factory(config, ports);
}
