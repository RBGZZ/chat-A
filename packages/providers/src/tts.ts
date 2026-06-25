import type { PcmChunk } from './audio';

/**
 * TTS(文字转语音)Provider 接缝(承 §4.1 STT/TTS 语种解绑 + 音色自定义/v2.1 音色复刻 + §4.3 可换性)。
 *
 * 设计要点(与 SttProvider/LlmProvider 对称):
 * - 业务层只依赖此接口;换引擎 = 换实现 + 改配置,链路不动(§4.3)。
 * - `id` **仅供 trace/日志**(§8.1),业务不得据此分支。
 * - 能力声明位(§4.1/§4.3):`languages`/`voiceId`/`sampleRate`/`streaming`/`requiresCuda`/`voiceCloning`
 *   就位,上层据此**路由 + fail-fast**。
 * - 流式优先(§4):`synthesize` 吐音频块流(中途可干净打断)。
 * - **音色复刻(§4.1/v2.1)**:`voiceCloning` 能力位 + opts 里的参考音频/文本/语种或预注册 voiceId。
 *
 * 输出音频:常见 24kHz mono Int16(Kokoro/OpenAI pcm;见 audio.ts 佐证)。
 */
export interface TtsProvider {
  /** provider 标识(如 'fake' / 'edge' / 'kokoro' / 'openai-compat' / 'gpt-sovits')——**仅供 trace/日志**。 */
  readonly id: string;
  /** 能力声明(§4.1/§4.3 能力路由 + 能力门)。 */
  readonly capabilities: TtsCapabilities;
  /**
   * 流式合成:文本 → 音频块流。
   * `opts.language` 不在 `capabilities.languages` 内、或请求复刻而 `voiceCloning=false` 时,
   * 实现应 fail-fast(§4.3,见 assertTtsLanguage / assertTtsCloning)。
   */
  synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk>;
}

/**
 * TTS 能力声明(§4.1/§4.3)。字段贴合真实引擎:
 * Edge-TTS 多语种内置音色;Kokoro 预置 voiceId;GPT-SoVITS/CosyVoice 支持 zero-shot 复刻。
 */
export interface TtsCapabilities {
  /**
   * 支持的语种(BCP-47/ISO-639-1,如 'zh'/'en');含 `'*'` 表示多语种(如 Edge 多语种音色)。
   */
  readonly languages: readonly string[];
  /**
   * 预置/可选音色 id 列表(如 Edge 'zh-CN-XiaoxiaoNeural'、Kokoro 'af_bella'、已注册复刻音色 'xiaoxue_v2')。
   * 缺省/空 = 该引擎不靠枚举 voiceId 选音(如纯 zero-shot 复刻)。
   */
  readonly voiceId?: readonly string[];
  /** 输出采样率(Hz);Kokoro/OpenAI pcm 为 24000,ElevenLabs pcm_16000 为 16000。 */
  readonly sampleRate: number;
  /** 是否支持流式产出音频块;false = 仅整段返回。 */
  readonly streaming: boolean;
  /** 是否要求 CUDA(本地 GPU 引擎,如 GPT-SoVITS);缺省视为不要求(§4.3;树莓派部署据此排除)。 */
  readonly requiresCuda?: boolean;
  /**
   * 是否支持**音色复刻 / zero-shot voice cloning**(§4.1/v2.1)。
   * true = 可吃参考音频(refAudio)做即时复刻,或选用已注册复刻音色(voiceId);
   * false = 仅内置音色;此时传复刻参数应 fail-fast(见 assertTtsCloning)。
   */
  readonly voiceCloning?: boolean;
}

/**
 * 参考音色样本(zero-shot 复刻用)。
 * 字段对应 GPT-SoVITS `ref_audio_path`/`prompt_text`/`prompt_lang`、CosyVoice `prompt_wav_upload`/`prompt_text`。
 *
 * 佐证:reference/.../Open-LLM-VTuber/.../tts/gpt_sovits_tts.py
 *   (请求体 ref_audio_path / prompt_text / prompt_lang);
 *   .../tts/cosyvoice2_tts.py(prompt_wav_upload + prompt_text);
 *   .../tts/coqui_tts.py(speaker_wav 本地路径)。
 */
export interface TtsRefAudio {
  /**
   * 参考音频(几秒 zero-shot 样本)。引擎多吃本地路径(GPT-SoVITS `ref_audio_path` /
   * CosyVoice 上传文件 / Coqui `speaker_wav`),故用字符串路径;若为内联样本可用 PcmChunk(实现自行落盘/编码)。
   */
  readonly source: string | PcmChunk;
  /** 参考音频对应的转写文本(GPT-SoVITS `prompt_text` / CosyVoice `prompt_text`);提升复刻保真。 */
  readonly refText?: string;
  /** 参考音频语种(GPT-SoVITS `prompt_lang`);省略时部分引擎回落到目标语种。 */
  readonly refLang?: string;
}

/**
 * 单次合成调用的参数(贴合真实引擎入参)。
 * 不设的字段一律**省略键**(exactOptionalPropertyTypes)。
 */
export interface TtsOptions {
  /** 目标语种(BCP-47/ISO-639-1;对应 GPT-SoVITS `text_lang`)。 */
  readonly language?: string;
  /**
   * 选用的音色 id(内置音色 Edge 'zh-CN-XiaoxiaoNeural' / Kokoro 'af_bella',
   * 或**已注册的复刻音色** 'xiaoxue_v2' —— 免每次传 refAudio,需 voiceCloning=true)。
   */
  readonly voiceId?: string;
  /** 语速(Kokoro `speed` / OpenAI `speed` / Edge `rate`;1.0 = 常速)。 */
  readonly speed?: number;
  /**
   * 即时音色复刻的参考样本(zero-shot)。给定即走复刻路径(需 voiceCloning=true,否则 fail-fast)。
   * 与 `voiceId` 二选一为主:voiceId 选已注册复刻音色;refAudio 现场复刻。
   */
  readonly refAudio?: TtsRefAudio;
  /**
   * **按调用透传**的说话风格/情绪指令(自然语言)。支持指令控制的 provider(如 CosyVoice)
   * 以此**优先于构造期静态指令**;未给则回落静态。不支持指令的 provider 忽略(纯加法)。
   * 用于"随心情说话"(persona PAD → 指令 → 逐回合注入)。⚠️ qwen-tts 当前仅用构造期静态指令、
   * 忽略本字段(per-call 接入为后续)。
   */
  readonly instruction?: string;
}

/**
 * 能力门 fail-fast(§4.3):请求语种不在能力集内即抛。`'*'` 视为通配(多语种)。
 */
export function assertTtsLanguage(cap: TtsCapabilities, language: string | undefined): void {
  if (language === undefined) return;
  if (cap.languages.includes('*') || cap.languages.includes(language)) return;
  throw new Error(
    `TTS 不支持语种 "${language}";该 provider 能力声明:[${cap.languages.join(', ')}]`,
  );
}

/**
 * 能力门 fail-fast(§4.3/v2.1):请求复刻(传 refAudio)而该 provider 不支持复刻即抛。
 * 选用已注册的复刻 voiceId 也需 voiceCloning=true(否则视为只支持内置音色,提前拦)。
 */
export function assertTtsCloning(cap: TtsCapabilities, opts: TtsOptions | undefined): void {
  if (opts?.refAudio === undefined) return; // 未请求即时复刻,不拦(voiceId 选内置音色由各实现自校验)。
  if (cap.voiceCloning === true) return;
  throw new Error(
    `TTS 不支持音色复刻(voiceCloning=false),但请求里带了 refAudio;请改用支持复刻的 provider`,
  );
}

/**
 * ISO-639-1 语种码 → Qwen `language_type` 名映射(已据官方核实 2026-06-24:
 * help.aliyun.com/zh/model-studio/qwen-tts-realtime + qwen-tts-api)。
 * qwen-tts realtime 的 `session.language_type` 取**首字母大写英文名**(不是 `zh`/`en` code);
 * voice 不自带语种,`Auto` 由服务端自动判定/处理混读。具名常量,无 magic。
 */
export const ISO_TO_QWEN_LANGUAGE: Readonly<Record<string, string>> = {
  zh: 'Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  de: 'German',
  it: 'Italian',
  pt: 'Portuguese',
  es: 'Spanish',
  fr: 'French',
  ru: 'Russian',
};

/** 全部合法 Qwen `language_type` 名(含 `Auto`;用于兼容用户直传合法名)。 */
export const QWEN_LANGUAGE_TYPES: readonly string[] = [
  'Auto',
  ...Object.values(ISO_TO_QWEN_LANGUAGE),
];

/**
 * 把项目内部统一的输出语种(ISO 码,如 'zh'/'en')映射成 Qwen `language_type` 名,用于
 * qwen-tts-realtime 握手(承 §4.1 语音 I/O 语种解耦在 qwen TTS 侧真正生效)。
 *
 * **回归硬线**:
 * - 未给 / 空 → 返回 undefined(=不发 language_type = 服务端默认 `Auto` = 逐字现状)。
 * - 命中 ISO 表(大小写不敏感) → 对应 Qwen 名。
 * - 已是合法 Qwen 名(大小写不敏感,含 `Auto`) → 归一到官方写法原样返回(兼容用户直传)。
 * - 其它未知 → 返回 undefined(优雅落回 Auto,**不抛**)。
 */
export function toQwenLanguageType(language?: string): string | undefined {
  const raw = language?.trim();
  if (raw === undefined || raw.length === 0) return undefined;
  const lower = raw.toLowerCase();
  // ISO 码命中(zh/en/...)。
  const mapped = ISO_TO_QWEN_LANGUAGE[lower];
  if (mapped !== undefined) return mapped;
  // 已是合法 Qwen 名(大小写不敏感)→ 归一到官方写法。
  const canonical = QWEN_LANGUAGE_TYPES.find((name) => name.toLowerCase() === lower);
  if (canonical !== undefined) return canonical;
  // 未知 → 不发(=Auto)。
  return undefined;
}
