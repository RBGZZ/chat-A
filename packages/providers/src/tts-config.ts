/**
 * TTS 配置(行为即配置,§3.2;接缝 §4.3 + 音色复刻 §4.1/v2.1)。
 *
 * **判别联合**(discriminated union):`kind` 决定形状 → 工厂零 if/else、零代码切换(镜像 EmbedderConfig)。
 * 字段贴合**真实引擎参数**:
 * - edge(Edge-TTS):voice/rate/volume/pitch/format;
 * - kokoro:voice/speed/sampleRate(24k)/lang;
 * - openai-compat(/audio/speech):model/voice/responseFormat/speed/stream;
 * - gpt-sovits(复刻 zero-shot):refAudioPath/promptText/promptLang/textLang + 预注册 voiceId;
 * - fake:确定性桩。
 * 加新引擎 = 加分支 + 在 tts-registry 注册,**createTts 核心零改动**。
 */
import type { Device, ComputeType } from './hardware';

export type TtsConfig =
  | FakeTtsConfig
  | EdgeTtsConfig
  | KokoroTtsConfig
  | OpenAiCompatTtsConfig
  | GptSovitsTtsConfig
  | QwenTtsRealtimeConfig
  | CosyVoiceTtsConfig;

/** 确定性桩(无依赖、可复现;支持复刻路径供单测)。 */
export interface FakeTtsConfig {
  readonly kind: 'fake';
  readonly languages?: readonly string[];
  /** 是否声明支持复刻(默认 true,便于测复刻路径)。 */
  readonly voiceCloning?: boolean;
}

/**
 * Edge-TTS(微软在线 TTS,多语种内置音色)。
 * 佐证:reference/.../Open-LLM-VTuber/.../tts/edge_tts.py(Communicate(text, voice, pitch, rate, volume));
 *   reference/.../projectBEA/.../tts/edge_tts_wrapper.py。输出 MP3。
 */
export interface EdgeTtsConfig {
  readonly kind: 'edge';
  readonly id?: string;
  /** 音色(如 'zh-CN-XiaoxiaoNeural' / 'en-US-AvaMultilingualNeural')。 */
  readonly voice: string;
  /** 语速(字符串百分比,如 '+0%' / '-10%')。 */
  readonly rate?: string;
  /** 音量(字符串百分比,如 '+0%')。 */
  readonly volume?: string;
  /** 音高(字符串 Hz,如 '+0Hz')。 */
  readonly pitch?: string;
  /** 输出格式(Edge 原生 MP3;留位以便上层转码)。 */
  readonly format?: 'mp3' | 'pcm';
  readonly languages?: readonly string[];
}

/**
 * Kokoro(本地轻量 TTS,24kHz Float32→Int16)。
 * 佐证:reference/.../projectBEA/.../tts/kokoro_tts_wrapper.py(create(text, voice, speed, lang) → (samples, 24000));
 *   reference/.../voice-core/.../voice/tts.py(float32 输出);reference/.../airi/.../adapters/kokoro.ts(24k WAV)。
 */
export interface KokoroTtsConfig {
  readonly kind: 'kokoro';
  readonly id?: string;
  /** 音色(如 'af_bella' / 'af_sky' / 'am_adam')。 */
  readonly voice: string;
  /** 语速(0.5-2.0,1.0 常速)。 */
  readonly speed?: number;
  /** 输出采样率(默认 24000)。 */
  readonly sampleRate?: number;
  /** 语种(如 'en-us')。 */
  readonly lang?: string;
  /** 设备(本地引擎据此选 CPU/GPU;共享 {@link Device},§5.10 C1;纯加法、省略时行为不变)。 */
  readonly device?: Device;
  /** 计算精度 / 量化档(本地引擎用;共享 {@link ComputeType},绑 profile 非 backend,§5.10 C1)。 */
  readonly computeType?: ComputeType;
  /** 是否要求 CUDA(能力位,§4.3 能力门 / §5.6;缺省视为不要求)。 */
  readonly requiresCuda?: boolean;
  readonly languages?: readonly string[];
}

/**
 * OpenAI 兼容 /audio/speech(云端 OpenAI / 本地 Kokoro-FastAPI 等以 OpenAI 协议暴露)。
 * 佐证:reference/.../Open-LLM-VTuber/.../tts/openai_tts.py(model/voice/response_format/speed + streaming);
 *   reference/Nexus-full/.../electron/services/ttsService.js(response_format:'pcm' → 24k mono int16)。
 */
export interface OpenAiCompatTtsConfig {
  readonly kind: 'openai-compat';
  readonly id?: string;
  /** 模型(如 'tts-1' / 'tts-1-hd' / 'kokoro')。 */
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.openai.com/v1'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 音色(如 'alloy' / 'af_sky+af_bella')。 */
  readonly voice: string;
  /** 响应格式(端点 `response_format`);pcm 直出便于流式播放。默认 'pcm'。 */
  readonly responseFormat?: 'pcm' | 'wav' | 'mp3' | 'opus';
  /** 语速(0.25-4.0,端点 `speed`);默认 1.0。 */
  readonly speed?: number;
  /** 是否流式;默认 true。 */
  readonly stream?: boolean;
  /** 输出采样率(pcm 时常为 24000)。 */
  readonly sampleRate?: number;
  readonly languages?: readonly string[];
}

/**
 * GPT-SoVITS(本地 zero-shot 音色复刻,HTTP API)。
 * 佐证:reference/.../Open-LLM-VTuber/.../tts/gpt_sovits_tts.py
 *   (默认端点 http://127.0.0.1:9880/tts;请求体 text/text_lang/ref_audio_path/prompt_lang/prompt_text/
 *    text_split_method/batch_size/media_type/streaming_mode)。
 * 复刻参数齐全,且支持选已注册音色 voiceId(免每次传 ref_audio)。
 */
export interface GptSovitsTtsConfig {
  readonly kind: 'gpt-sovits';
  readonly id?: string;
  /** API 端点根(默认 'http://127.0.0.1:9880'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 目标语种(端点 `text_lang`,如 'zh'/'en')。 */
  readonly textLang?: string;
  /** 默认参考音频路径(端点 `ref_audio_path`;synthesize 时可被 opts.refAudio 覆盖)。 */
  readonly refAudioPath?: string;
  /** 默认参考文本(端点 `prompt_text`)。 */
  readonly promptText?: string;
  /** 默认参考语种(端点 `prompt_lang`)。 */
  readonly promptLang?: string;
  /** 文本切分方法(端点 `text_split_method`,如 'cut5')。 */
  readonly textSplitMethod?: string;
  /** 是否流式(端点 `streaming_mode`);默认 true。 */
  readonly stream?: boolean;
  /** 输出采样率(GPT-SoVITS 常为 32000;按部署实际设)。 */
  readonly sampleRate?: number;
  /** 预注册复刻音色 id 列表(能力位 voiceId;选用免传 refAudio)。 */
  readonly voiceId?: readonly string[];
  /** 设备(GPT-SoVITS 本地推理据此选 CPU/GPU;共享 {@link Device},§5.10 C1;纯加法、省略时行为不变)。 */
  readonly device?: Device;
  /** 计算精度 / 量化档(共享 {@link ComputeType},绑 profile 非 backend,§5.10 C1)。 */
  readonly computeType?: ComputeType;
  /** 是否要求 CUDA(GPT-SoVITS 常需 GPU;能力位,§4.3 能力门 / §5.6;缺省视为不要求)。 */
  readonly requiresCuda?: boolean;
  readonly languages?: readonly string[];
}

/**
 * Qwen(阿里 DashScope)qwen-tts-realtime —— WebSocket 流式 TTS(OpenAI-Realtime 风格)。
 * 默认输出 PCM 24kHz/16bit/mono,直对齐 PcmChunk。内置音色,不支持 zero-shot 复刻。
 * 协议详见 openspec/changes/qwen-tts-realtime/design.md;model id **用稳定别名、别写死日期快照**。
 */
export interface QwenTtsRealtimeConfig {
  readonly kind: 'qwen-tts';
  readonly id?: string;
  /** 模型 id(如 'qwen3-tts-flash-realtime' / 'qwen3-tts-instruct-flash-realtime')。 */
  readonly model: string;
  /** DASHSCOPE_API_KEY(缺省时各 provider fail-fast)。 */
  readonly apiKey: string;
  /** 音色(如 'Cherry'/'Chelsie'/'Serena')。 */
  readonly voice: string;
  /** WebSocket 端点(默认北京区;海外区 dashscope-intl 可覆盖)。 */
  readonly endpoint?: string;
  /** 输出格式(WS 协议值 'pcm'|'wav'|'mp3'|'opus';默认 'pcm')。 */
  readonly responseFormat?: string;
  /** 切分模式(默认 'server_commit')。 */
  readonly mode?: 'server_commit' | 'commit';
  /** 情感/风格指令(自然语言;仅 instruct 版生效)。 */
  readonly instructions?: string;
  /** 输出采样率(默认 24000)。 */
  readonly sampleRate?: number;
  readonly languages?: readonly string[];
  /**
   * 是否启用**复刻音色合成**(能力位,§4.1/v2.1)。默认/省略 = false(内置音色)。
   * 配 vc 实时模型(model=`qwen3-tts-vc-realtime`)+ 此位 true 时,`TtsOptions.voiceId`
   * (千问声音复刻 voice id,经 CHAT_A_VOICE_ID / voice-profile 流入)当 WS `voice` 透传。
   */
  readonly voiceCloning?: boolean;
}

/**
 * CosyVoice(阿里 DashScope)语音合成 —— WebSocket DashScope `run-task` 协议(**与 qwen-tts 不同**)。
 * 仅北京地域、**无系统音色**(必须先复刻):合成 model 须与复刻 target_model 逐字一致(cosyvoice-v3.5-flash);
 * voice = 复刻 voice_id(经 CHAT_A_VOICE_ID / voice-profile → TtsOptions.voiceId 流入);音频走二进制裸帧。
 * 协议详见 openspec/changes/cosyvoice-clone-synth/design.md。
 */
export interface CosyVoiceTtsConfig {
  readonly kind: 'cosyvoice';
  readonly id?: string;
  /** 模型 id(默认 cosyvoice-v3.5-flash;须与复刻 target_model 逐字一致)。 */
  readonly model?: string;
  /** DASHSCOPE_API_KEY(缺省时 provider fail-fast)。 */
  readonly apiKey: string;
  /** 默认音色(复刻 voice_id;通常由 opts.voiceId 在合成时传入,config 可留空)。 */
  readonly voice?: string;
  /** WebSocket 端点(默认北京区)。 */
  readonly endpoint?: string;
  /** 输出格式(pcm|wav|mp3|opus;默认 pcm)。 */
  readonly format?: string;
  /** 输出采样率(默认 24000)。 */
  readonly sampleRate?: number;
  /** 语速(0.5~2.0)。 */
  readonly rate?: number;
  /** 音调(0.5~2.0)。 */
  readonly pitch?: number;
  /** 音量(0~100)。 */
  readonly volume?: number;
  readonly languages?: readonly string[];
}

/**
 * 从环境变量加载——用户自己选 TTS 引擎:
 *   CHAT_A_TTS_KIND      = fake | edge | kokoro | openai-compat | gpt-sovits | qwen-tts
 *                          (默认:有 base URL+key+model 则 openai-compat,否则 fake)
 *   qwen-tts 专有:CHAT_A_TTS_ENDPOINT / CHAT_A_TTS_MODE / CHAT_A_TTS_INSTRUCTIONS;
 *                  apiKey 回落 CHAT_A_DASHSCOPE_API_KEY
 *   CHAT_A_TTS_VOICE / CHAT_A_TTS_MODEL / CHAT_A_TTS_API_KEY / CHAT_A_TTS_BASE_URL
 *   CHAT_A_TTS_SPEED / CHAT_A_TTS_RESPONSE_FORMAT / CHAT_A_TTS_LANGUAGE / CHAT_A_TTS_SAMPLE_RATE
 *   (各引擎专有字段见对应 config 接口)
 *
 * 缺关键项时**自动降级**到 fake(承可测试性)。
 */
export function loadTtsConfig(env: NodeJS.ProcessEnv = process.env): TtsConfig {
  const kind = env['CHAT_A_TTS_KIND'];
  const voice = env['CHAT_A_TTS_VOICE'];
  const model = env['CHAT_A_TTS_MODEL'];
  const apiKey = env['CHAT_A_TTS_API_KEY'];
  const baseURL = env['CHAT_A_TTS_BASE_URL'];
  const speedRaw = env['CHAT_A_TTS_SPEED'];
  const speed = speedRaw && Number.isFinite(Number(speedRaw)) ? Number(speedRaw) : undefined;
  const sampleRaw = env['CHAT_A_TTS_SAMPLE_RATE'];
  const sampleRate = sampleRaw && Number.isFinite(Number(sampleRaw)) ? Number(sampleRaw) : undefined;
  const language = env['CHAT_A_TTS_LANGUAGE'];

  const hasOpenAi =
    typeof model === 'string' &&
    model.length > 0 &&
    typeof apiKey === 'string' &&
    apiKey.length > 0 &&
    typeof baseURL === 'string' &&
    baseURL.length > 0;

  const resolved = kind ?? (hasOpenAi ? 'openai-compat' : 'fake');

  switch (resolved) {
    case 'edge':
      return {
        kind: 'edge',
        voice: voice ?? '',
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(env['CHAT_A_TTS_RATE'] ? { rate: env['CHAT_A_TTS_RATE'] } : {}),
        ...(env['CHAT_A_TTS_VOLUME'] ? { volume: env['CHAT_A_TTS_VOLUME'] } : {}),
        ...(env['CHAT_A_TTS_PITCH'] ? { pitch: env['CHAT_A_TTS_PITCH'] } : {}),
        ...(env['CHAT_A_TTS_RESPONSE_FORMAT']
          ? { format: env['CHAT_A_TTS_RESPONSE_FORMAT'] as 'mp3' | 'pcm' }
          : {}),
      };
    case 'kokoro':
      return {
        kind: 'kokoro',
        voice: voice ?? '',
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        ...(env['CHAT_A_TTS_LANG'] ? { lang: env['CHAT_A_TTS_LANG'] } : {}),
      };
    case 'openai-compat':
      return {
        kind: 'openai-compat',
        model: model ?? '',
        apiKey: apiKey ?? '',
        baseURL: baseURL ?? '',
        voice: voice ?? '',
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(env['CHAT_A_TTS_RESPONSE_FORMAT']
          ? { responseFormat: env['CHAT_A_TTS_RESPONSE_FORMAT'] as 'pcm' | 'wav' | 'mp3' | 'opus' }
          : {}),
        ...(speed !== undefined ? { speed } : {}),
        ...(env['CHAT_A_TTS_STREAM'] === 'false' ? { stream: false } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
      };
    case 'qwen-tts': {
      // apiKey 回落 DashScope 专用环境变量(CHAT_A_TTS_API_KEY 优先,缺省取 CHAT_A_DASHSCOPE_API_KEY)。
      const dashKey = apiKey ?? env['CHAT_A_DASHSCOPE_API_KEY'];
      const mode = env['CHAT_A_TTS_MODE'];
      return {
        kind: 'qwen-tts',
        model: model ?? '',
        apiKey: dashKey ?? '',
        voice: voice ?? '',
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(env['CHAT_A_TTS_ENDPOINT'] ? { endpoint: env['CHAT_A_TTS_ENDPOINT'] } : {}),
        ...(env['CHAT_A_TTS_RESPONSE_FORMAT']
          ? { responseFormat: env['CHAT_A_TTS_RESPONSE_FORMAT'] }
          : {}),
        ...(mode === 'server_commit' || mode === 'commit' ? { mode } : {}),
        ...(env['CHAT_A_TTS_INSTRUCTIONS'] ? { instructions: env['CHAT_A_TTS_INSTRUCTIONS'] } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        ...(language ? { languages: [language] } : {}),
        // 复刻能力位:CHAT_A_TTS_VOICE_CLONING=1/true 时启用(配 vc 实时模型用);省略=内置音色。
        ...(isTruthy(env['CHAT_A_TTS_VOICE_CLONING']) ? { voiceCloning: true } : {}),
      };
    }
    case 'cosyvoice': {
      // apiKey 回落 DashScope 专用环境变量(CHAT_A_TTS_API_KEY 优先,缺省取 CHAT_A_DASHSCOPE_API_KEY)。
      const dashKey = apiKey ?? env['CHAT_A_DASHSCOPE_API_KEY'];
      const num = (v: string | undefined): number | undefined =>
        v !== undefined && Number.isFinite(Number(v)) ? Number(v) : undefined;
      const rate = num(env['CHAT_A_TTS_RATE']);
      const pitch = num(env['CHAT_A_TTS_PITCH']);
      const volume = num(env['CHAT_A_TTS_VOLUME']);
      return {
        kind: 'cosyvoice',
        apiKey: dashKey ?? '',
        ...(model !== undefined ? { model } : {}),
        ...(voice !== undefined ? { voice } : {}),
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(env['CHAT_A_TTS_ENDPOINT'] ? { endpoint: env['CHAT_A_TTS_ENDPOINT'] } : {}),
        ...(env['CHAT_A_TTS_RESPONSE_FORMAT'] ? { format: env['CHAT_A_TTS_RESPONSE_FORMAT'] } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
        ...(rate !== undefined ? { rate } : {}),
        ...(pitch !== undefined ? { pitch } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(language ? { languages: [language] } : {}),
      };
    }
    case 'gpt-sovits':
      return {
        kind: 'gpt-sovits',
        baseURL: baseURL ?? 'http://127.0.0.1:9880',
        ...(env['CHAT_A_TTS_ID'] ? { id: env['CHAT_A_TTS_ID'] } : {}),
        ...(language ? { textLang: language } : {}),
        ...(env['CHAT_A_TTS_REF_AUDIO'] ? { refAudioPath: env['CHAT_A_TTS_REF_AUDIO'] } : {}),
        ...(env['CHAT_A_TTS_PROMPT_TEXT'] ? { promptText: env['CHAT_A_TTS_PROMPT_TEXT'] } : {}),
        ...(env['CHAT_A_TTS_PROMPT_LANG'] ? { promptLang: env['CHAT_A_TTS_PROMPT_LANG'] } : {}),
        ...(env['CHAT_A_TTS_STREAM'] === 'false' ? { stream: false } : {}),
        ...(sampleRate !== undefined ? { sampleRate } : {}),
      };
    default:
      return { kind: 'fake' };
  }
}

/** 解析布尔型环境变量(1/true/yes/on,大小写不敏感)。省略/空/其它 = false。 */
function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}
