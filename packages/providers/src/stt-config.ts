/**
 * STT 配置(行为即配置,§3.2;接缝 §4.3)。
 *
 * **判别联合**(discriminated union):`kind` 字段决定形状 → 工厂零 if/else 散落、零代码切换
 * (镜像 EmbedderConfig 的最高优先级接缝范式)。字段贴合**真实引擎参数**:
 * - whisper-local(faster-whisper / whisper.cpp / sherpa-onnx):model/device/computeType/language/beamSize/vadFilter/sampleRate;
 * - openai-compat(/audio/transcriptions):model/language/responseFormat/temperature/stream;
 * - fake:确定性桩。
 * 加新引擎 = 加一个分支 + 在 stt-registry 注册,**createStt 核心零改动**。
 */
import type { Device, ComputeType } from './hardware';

export type SttConfig = FakeSttConfig | OpenAiCompatSttConfig | WhisperLocalSttConfig;

/**
 * DashScope(阿里百炼)OpenAI 兼容端点根(纯文本 / ASR transcriptions 共用);与 registry 的
 * `QWEN_DASHSCOPE_BASE_URL` 同值。云 ASR 经此端点 `/audio/transcriptions` 上传 WAV(qwen3-asr-flash)。
 */
export const QWEN_DASHSCOPE_COMPAT_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
/** DashScope 录音文件识别默认模型(< 10MB 走 OpenAI 兼容 transcriptions)。 */
export const QWEN_ASR_DEFAULT_MODEL = 'qwen3-asr-flash';

/** 确定性桩(无依赖、可复现;对应 LLM 侧 fake)。 */
export interface FakeSttConfig {
  readonly kind: 'fake';
  /** 支持语种声明(默认多语种 '*');用于测试能力门。 */
  readonly languages?: readonly string[];
}

/**
 * OpenAI 兼容 /audio/transcriptions(云端 OpenAI / Groq Whisper / 自托管 OpenAI 协议端点)。
 * 佐证:reference/.../Open-LLM-VTuber/.../tts(asr)/groq_whisper_asr.py(model/response_format/language/temperature);
 *   reference/.../ZerolanLiveRobot/pipeline/asr/whisper_asr.py(multipart file + model/language/prompt/temperature/response_format);
 *   reference/.../voice-infra/.../openai/stt.py(transcriptions.create model/language/prompt/response_format)。
 */
export interface OpenAiCompatSttConfig {
  readonly kind: 'openai-compat';
  /** trace 标识(如 'openai' / 'groq-whisper');缺省回落到 kind。 */
  readonly id?: string;
  /** 模型串(如 'whisper-1' / 'gpt-4o-mini-transcribe' / 'distil-whisper-large-v3-en')。 */
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.openai.com/v1' / 'https://api.groq.com/openai/v1'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 目标语种(ISO-639-1);省略 = 自动检测(language 不下发)。 */
  readonly language?: string;
  /** 响应格式(对应端点 `response_format`);默认 'json'。 */
  readonly responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  /** 采样温度(0.0-1.0,对应端点 `temperature`);默认 0。 */
  readonly temperature?: number;
  /** 是否流式(OpenAI realtime/transcription stream;批式端点不支持)。默认 false。 */
  readonly stream?: boolean;
  /** 声明支持语种(能力位);省略默认 ['*'](自动检测)。 */
  readonly languages?: readonly string[];
}

/**
 * 本地引擎(faster-whisper / whisper.cpp / sherpa-onnx)——占位配置(真引擎以后接,§4.3)。
 * 佐证:reference/.../Open-LLM-VTuber/.../asr/faster_whisper_asr.py
 *   (WhisperModel(model_size_or_path/device/compute_type) + transcribe(beam_size/language/...));
 *   .../asr/sherpa_onnx_asr.py(sample_rate=16000 / provider 'cpu'|'cuda')。
 */
export interface WhisperLocalSttConfig {
  readonly kind: 'whisper-local';
  /** trace 标识;缺省回落到 kind。 */
  readonly id?: string;
  /** 模型大小或路径(faster-whisper `model_size_or_path`,如 'large-v3' / 'distil-medium.en')。 */
  readonly model: string;
  /** 设备(faster-whisper `device`;共享 {@link Device}:'cpu'|'cuda'|'auto')。 */
  readonly device?: Device;
  /** 计算精度(faster-whisper `compute_type`;共享 {@link ComputeType},绑 profile 非 backend,§5.10 C1)。 */
  readonly computeType?: ComputeType;
  /**
   * 是否要求 CUDA(能力位,§4.3 能力门 / §5.6 profile gate)。
   * 缺省视为不要求;raspberry/browser 档据此 fail-fast 排除需 GPU 的档位。
   */
  readonly requiresCuda?: boolean;
  /** 目标语种(ISO-639-1);省略 = 自动检测。 */
  readonly language?: string;
  /** beam search 宽度(faster-whisper `beam_size`,1=贪心 / 5=beam);默认引擎决定。 */
  readonly beamSize?: number;
  /** 是否启用 VAD 过滤(faster-whisper `vad_filter`)。 */
  readonly vadFilter?: boolean;
  /** 期望输入采样率(Hz);默认 16000。 */
  readonly sampleRate?: number;
  /** 声明支持语种(能力位)。 */
  readonly languages?: readonly string[];
}

/**
 * 从环境变量加载——用户自己选 STT 引擎:
 *   CHAT_A_STT_KIND          = fake | openai-compat | whisper-local(默认:有 base URL+key+model 则 openai-compat,否则 fake)
 *   CHAT_A_STT_MODEL         = 模型串
 *   CHAT_A_STT_API_KEY       = API key(openai-compat 用)
 *   CHAT_A_STT_BASE_URL      = OpenAI 兼容端点根
 *   CHAT_A_STT_LANGUAGE      = 目标语种(省略 = 自动检测)
 *   CHAT_A_STT_RESPONSE_FORMAT / CHAT_A_STT_TEMPERATURE / CHAT_A_STT_STREAM(openai-compat)
 *   CHAT_A_STT_DEVICE / CHAT_A_STT_COMPUTE_TYPE / CHAT_A_STT_BEAM_SIZE / CHAT_A_STT_VAD_FILTER(whisper-local)
 *
 * 缺关键项时**自动降级**到 fake(承可测试性):保证无配置也能跑通。
 */
export function loadSttConfig(env: NodeJS.ProcessEnv = process.env): SttConfig {
  const kind = env['CHAT_A_STT_KIND'];
  const model = env['CHAT_A_STT_MODEL'];
  const apiKey = env['CHAT_A_STT_API_KEY'];
  const baseURL = env['CHAT_A_STT_BASE_URL'];
  const language = env['CHAT_A_STT_LANGUAGE'];

  // DashScope 便捷档(填 key 即用):CHAT_A_STT_KIND=qwen → DashScope 云 ASR 经 OpenAI 兼容端点。
  // key 回落 CHAT_A_DASHSCOPE_API_KEY;model/baseURL 有内置默认,可被 CHAT_A_STT_MODEL/BASE_URL 覆盖。
  if (kind === 'qwen') {
    const dashKey = apiKey ?? env['CHAT_A_DASHSCOPE_API_KEY'];
    const temperatureRawQ = env['CHAT_A_STT_TEMPERATURE'];
    const temperatureQ =
      temperatureRawQ && Number.isFinite(Number(temperatureRawQ)) ? Number(temperatureRawQ) : undefined;
    const responseFormatQ = env['CHAT_A_STT_RESPONSE_FORMAT'] as
      | OpenAiCompatSttConfig['responseFormat']
      | undefined;
    return {
      kind: 'openai-compat',
      id: env['CHAT_A_STT_ID'] ?? 'qwen-asr',
      model: model ?? QWEN_ASR_DEFAULT_MODEL,
      apiKey: dashKey ?? '',
      baseURL: baseURL ?? QWEN_DASHSCOPE_COMPAT_BASE_URL,
      ...(language ? { language } : {}),
      ...(responseFormatQ ? { responseFormat: responseFormatQ } : {}),
      ...(temperatureQ !== undefined ? { temperature: temperatureQ } : {}),
    };
  }

  const hasOpenAi =
    typeof model === 'string' &&
    model.length > 0 &&
    typeof apiKey === 'string' &&
    apiKey.length > 0 &&
    typeof baseURL === 'string' &&
    baseURL.length > 0;

  const resolved = kind ?? (hasOpenAi ? 'openai-compat' : 'fake');

  if (resolved === 'openai-compat') {
    const temperatureRaw = env['CHAT_A_STT_TEMPERATURE'];
    const temperature =
      temperatureRaw && Number.isFinite(Number(temperatureRaw)) ? Number(temperatureRaw) : undefined;
    const responseFormat = env['CHAT_A_STT_RESPONSE_FORMAT'] as
      | OpenAiCompatSttConfig['responseFormat']
      | undefined;
    return {
      kind: 'openai-compat',
      model: model ?? '',
      apiKey: apiKey ?? '',
      baseURL: baseURL ?? '',
      ...(env['CHAT_A_STT_ID'] ? { id: env['CHAT_A_STT_ID'] } : {}),
      ...(language ? { language } : {}),
      ...(responseFormat ? { responseFormat } : {}),
      ...(temperature !== undefined ? { temperature } : {}),
      ...(env['CHAT_A_STT_STREAM'] === 'true' ? { stream: true } : {}),
    };
  }

  if (resolved === 'whisper-local') {
    const beamRaw = env['CHAT_A_STT_BEAM_SIZE'];
    const beamSize = beamRaw && Number.isFinite(Number(beamRaw)) ? Number(beamRaw) : undefined;
    const sampleRaw = env['CHAT_A_STT_SAMPLE_RATE'];
    const sampleRate = sampleRaw && Number.isFinite(Number(sampleRaw)) ? Number(sampleRaw) : undefined;
    return {
      kind: 'whisper-local',
      model: model ?? '',
      ...(env['CHAT_A_STT_ID'] ? { id: env['CHAT_A_STT_ID'] } : {}),
      ...(env['CHAT_A_STT_DEVICE'] ? { device: env['CHAT_A_STT_DEVICE'] as Device } : {}),
      ...(env['CHAT_A_STT_COMPUTE_TYPE']
        ? { computeType: env['CHAT_A_STT_COMPUTE_TYPE'] as ComputeType }
        : {}),
      ...(language ? { language } : {}),
      ...(beamSize !== undefined ? { beamSize } : {}),
      ...(env['CHAT_A_STT_VAD_FILTER'] === 'true' ? { vadFilter: true } : {}),
      ...(env['CHAT_A_STT_REQUIRES_CUDA'] === 'true' ? { requiresCuda: true } : {}),
      ...(sampleRate !== undefined ? { sampleRate } : {}),
    };
  }

  return { kind: 'fake' };
}
