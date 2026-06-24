import type { PcmChunk } from './audio';

/**
 * STT(语音转文字 / ASR)Provider 接缝(承 §4.1 STT/TTS 语种解绑 + §4.3 语音 Provider 可换性)。
 *
 * 设计要点(与 LlmProvider/Embedder 完全对称):
 * - 业务层只依赖此接口;换引擎 = 换实现 + 改配置,回合/EOU 逻辑不动(§4.3)。
 * - `id` **仅供 trace/日志**(§8.1),业务逻辑不得据此分支。
 * - 能力声明位(§4.1 能力路由 / §4.3 能力门):`languages`/`streaming`/`sampleRate`/`requiresCuda`
 *   就位,上层据此**路由 + fail-fast**(不支持的语种/能力提前拦,不进真实请求)。
 * - 流式优先(§4):`transcribe` 吃音频块流,吐 partial→final 的转写事件流。
 *
 * 输入音频:16kHz mono s16le(Whisper 系硬约定;见 audio.ts 佐证)。
 */
export interface SttProvider {
  /** provider 标识(如 'fake' / 'whisper-local' / 'openai-compat')——**仅供 trace/日志**,业务不得据此分支。 */
  readonly id: string;
  /** 能力声明(§4.1/§4.3 能力路由 + 能力门)。 */
  readonly capabilities: SttCapabilities;
  /**
   * 流式转写:吃音频块流 → 吐转写事件(partial 多次、final 收尾)。
   * `opts.language` 不在 `capabilities.languages` 内时,实现应 fail-fast(§4.3,见 assertSttLanguage)。
   */
  transcribe(audio: AsyncIterable<PcmChunk>, opts?: SttOptions, signal?: AbortSignal): AsyncIterable<SttResult>;
}

/**
 * STT 能力声明(§4.1 能力路由 / §4.3 能力门 fail-fast)。
 * 字段贴合真实引擎:本地引擎需 16kHz、可能 requiresCuda;云端流式与否、支持语种各异。
 */
export interface SttCapabilities {
  /**
   * 支持的语种(BCP-47 / ISO-639-1,如 'zh' / 'en');
   * 含 `'*'` 表示自动检测 / 多语种(如 Whisper language=None、Deepgram 'multi')。
   */
  readonly languages: readonly string[];
  /** 是否支持流式 partial(interim);false = 仅整段 final(如批式 /audio/transcriptions)。 */
  readonly streaming: boolean;
  /** 期望输入采样率(Hz);Whisper 系为 16000。上层据此决定是否需重采样。 */
  readonly sampleRate: number;
  /** 是否要求 CUDA(本地 GPU 引擎);缺省视为不要求(§4.3 能力门;部署到树莓派时据此排除)。 */
  readonly requiresCuda?: boolean;
}

/**
 * 单次转写调用的参数(贴合真实引擎入参)。
 * 不设的字段一律**省略键**(exactOptionalPropertyTypes:绝不显式赋 undefined)。
 */
export interface SttOptions {
  /** 目标语种(BCP-47/ISO-639-1);省略 = 自动检测(对应 Whisper language=None)。 */
  readonly language?: string;
  /**
   * 给模型的引导提示(对应 faster-whisper `initial_prompt` / OpenAI `prompt`);
   * 用于纠偏专有名词、上下文延续。
   */
  readonly prompt?: string;
}

/**
 * 一条转写结果(对应 realtime-voice-agent-demo 的 `Transcript{text, is_final}` /
 * LiveKit INTERIM_TRANSCRIPT vs FINAL_TRANSCRIPT)。
 * `isFinal=false` 为 partial(临时猜测,可被后续覆盖);`isFinal=true` 标记一段话收尾。
 *
 * 佐证:reference/.../realtime-voice-agent-demo/.../backend/app/adapters/stt/base.py
 *   (`@dataclass Transcript: text:str; is_final:bool`);
 *   .../adapters/stt/deepgram.py(`is_final = getattr(result,'is_final',False)`)。
 */
export interface SttResult {
  readonly text: string;
  readonly isFinal: boolean;
  /** 检测到的语种(可空;部分引擎在 final 上回报,如 faster-whisper info.language)。 */
  readonly language?: string;
  /**
   * 从语音读出的 prosody 情绪信号(§7#5「听出怎么说的」)。**纯加法、默认缺席**:
   * 既有 provider(fake/openai-compat/whisper-local)一律不设此键(exactOptionalPropertyTypes
   * 下字段缺席),既有消费者读到 undefined、行为字面不变。仅 qwen-asr 等带 prosody 标注的引擎填。
   */
  readonly emotion?: SttEmotion;
}

/**
 * STT 可读出的离散 prosody 情绪标签(对齐 qwen3-asr-flash 官方 7 类)。
 * 与具体 provider 解耦:任何能从语音读情绪的实现皆可填(后续 realtime ASR 复用同一面)。
 */
export type SttEmotionLabel =
  | 'surprised'
  | 'neutral'
  | 'happy'
  | 'sad'
  | 'disgusted'
  | 'angry'
  | 'fearful';

/** 一条 prosody 情绪信号:离散标签 + 可选置信度。 */
export interface SttEmotion {
  /** ASR 给出的离散情绪标签。 */
  readonly label: SttEmotionLabel;
  /** 置信度 [0,1](若引擎给出;qwen3-asr 当前未稳定回报,留位)。 */
  readonly confidence?: number;
}

/**
 * 能力门 fail-fast(§4.3):请求语种不在能力集内即抛(沿用 LLM 侧"明确报错而非静默吞配置")。
 * `'*'` 视为通配(自动检测/多语种)。供各 STT 实现在 transcribe 入口调用。
 */
export function assertSttLanguage(cap: SttCapabilities, language: string | undefined): void {
  if (language === undefined) return; // 未指定 = 交给引擎自动检测,不拦。
  if (cap.languages.includes('*') || cap.languages.includes(language)) return;
  throw new Error(
    `STT 不支持语种 "${language}";该 provider 能力声明:[${cap.languages.join(', ')}]`,
  );
}
