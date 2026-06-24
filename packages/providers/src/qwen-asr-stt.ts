import type { PcmChunk } from './audio';
import { STT_SAMPLE_RATE_HZ } from './audio';
import { assertSttLanguage } from './stt';
import type {
  SttCapabilities,
  SttEmotion,
  SttEmotionLabel,
  SttOptions,
  SttProvider,
  SttResult,
} from './stt';

/**
 * Qwen(阿里 DashScope)qwen3-asr-flash —— 批式云端 STT + **从语音读 prosody 情绪**(承 §7#5)。
 *
 * 为什么新建而非复用 OpenAiCompatStt:qwen3-asr 经 OpenAI 兼容端点走的是**多模态
 * `/chat/completions`**(音频作为 `input_audio` base64 Data URL),**不是** `/audio/transcriptions`
 * 的 multipart——形态不同,故另起一个 provider(见 openspec/changes/prosody-stt-emotion/design.md §1)。
 *
 * 协议(调研结论,以官方文档当时版本为准):
 * - 端点 `POST {baseURL}/chat/completions`;鉴权 `Authorization: Bearer <key>`(**绝不打印 key**)。
 * - 请求体:`{ model, messages:[{role:'user', content:[{type:'input_audio', input_audio:{data}}]}], asr_options:{language,enable_itn} }`。
 * - 响应:文本 `choices[0].message.content`;**情绪 `choices[0].message.annotations[].emotion`**(7 类)。
 *
 * 形态:批式非流式(整段上传 → 整段转写),`capabilities.streaming=false`,只 emit 一条 `isFinal:true`。
 * 可测性(R1 注入接缝,镜像 qwen-tts 的 wsFactory):HTTP 经**注入式 fetch 端口** {@link SttFetch},
 * 单测注入假 fetch、**全程不触真网络**;缺省用全局 `fetch`。
 */

/** 最小响应面(不泄漏 DOM lib 类型到接口签名)。 */
export interface SttFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

/** 注入式 fetch 端口:由 url + init 发一次 HTTP。缺省用全局 `fetch`。 */
export type SttFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<SttFetchResponse>;

export interface QwenAsrSttOptions {
  /** provider 标识(默认 'qwen-asr')——仅供 trace/日志(§8.1)。 */
  readonly id?: string;
  /** 模型串(稳定别名,如 'qwen3-asr-flash';**别写死日期快照**)。 */
  readonly model: string;
  /** DASHSCOPE_API_KEY;缺失/空 → 构造 fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** OpenAI 兼容端点根(默认北京区 compatible-mode;海外区可覆盖),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 默认目标语种(可被 transcribe opts 覆盖);省略 = 多语种自动检测。 */
  readonly language?: string;
  /** 逆文本规整 enable_itn(数字/标点规范化);省略 = 不下发。 */
  readonly enableItn?: boolean;
  /** 声明支持语种(能力位);默认 ['*'](26 语种多语种)。 */
  readonly languages?: readonly string[];
  /** 注入的 fetch 端口(测试用);缺省用全局 fetch。 */
  readonly fetch?: SttFetch;
}

/** qwen3-asr 默认模型(与 stt-config 常量同义,避免循环依赖在此另立)。 */
export const QWEN_ASR_MODEL = 'qwen3-asr-flash';

/** 官方 7 类情绪枚举(用于校验服务端返回值,非法值忽略不污染)。 */
const VALID_EMOTIONS: ReadonlySet<string> = new Set<SttEmotionLabel>([
  'surprised',
  'neutral',
  'happy',
  'sad',
  'disgusted',
  'angry',
  'fearful',
]);

export class QwenAsrStt implements SttProvider {
  readonly id: string;
  readonly capabilities: SttCapabilities;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #language: string | undefined;
  readonly #enableItn: boolean | undefined;
  readonly #fetch: SttFetch;

  constructor(opts: QwenAsrSttOptions) {
    if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      // 缺 key fail-fast(沿用"明确报错而非静默吞配置"):提示设环境变量(不打印任何 key)。
      throw new Error(
        `qwen-asr 需要 DashScope API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或 CHAT_A_STT_API_KEY)`,
      );
    }
    this.id = opts.id ?? 'qwen-asr';
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#language = opts.language;
    this.#enableItn = opts.enableItn;
    this.#fetch = opts.fetch ?? defaultFetch;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      streaming: false, // 批式 /chat/completions:整段上传,无 partial。
      sampleRate: STT_SAMPLE_RATE_HZ, // 16kHz mono s16le 上传。
    };
  }

  async *transcribe(
    audio: AsyncIterable<PcmChunk>,
    opts?: SttOptions,
    signal?: AbortSignal,
  ): AsyncIterable<SttResult> {
    const language = opts?.language ?? this.#language;
    // 能力门 fail-fast(§4.3):不支持的语种提前拦,不发请求。
    assertSttLanguage(this.capabilities, language);

    // 进入即查取消:已取消则不发请求、空产出(与现有 provider 一致,干净停止)。
    if (signal?.aborted === true) return;

    // 聚合音频流 → 单个 WAV(批式端点要完整音频),base64 Data URL 塞进 input_audio。
    const chunks: PcmChunk[] = [];
    for await (const c of audio) chunks.push(c);
    const wav = encodeWav(chunks);
    const dataUrl = `data:audio/wav;base64,${bytesToBase64(wav)}`;

    const body = buildRequestBody(this.#model, dataUrl, language, this.#enableItn);

    const res = await this.#fetch(`${this.#baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.#apiKey}`, // **不打印 key**。
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }

    const data = (await res.json()) as ChatCompletionLike;
    const message = data.choices?.[0]?.message;
    const text = (typeof message?.content === 'string' ? message.content : '').trim();
    const emotion = extractEmotion(message?.annotations);
    const detected = extractAnnotationLanguage(message?.annotations);
    const lang = detected ?? language;

    yield {
      text,
      isFinal: true,
      ...(lang !== undefined ? { language: lang } : {}),
      ...(emotion !== undefined ? { emotion } : {}), // 纯加法:无情绪标注则不设此键。
    };
  }
}

/** 响应结构最小面(只取需要的字段;其余忽略)。 */
interface ChatCompletionLike {
  readonly choices?: readonly {
    readonly message?: {
      readonly content?: unknown;
      readonly annotations?: readonly AnnotationLike[];
    };
  }[];
}
interface AnnotationLike {
  readonly type?: unknown;
  readonly language?: unknown;
  readonly emotion?: unknown;
}

/**
 * 请求体构造(抽出以应对协议歧义:`asr_options` 平铺 vs `extra_body` 嵌套,见 design §1.2)。
 * 当前采用原生 fetch 友好的**顶层平铺**形态;真机若证实需嵌套,改此一处即可(爆炸半径可控)。
 */
function buildRequestBody(
  model: string,
  audioDataUrl: string,
  language: string | undefined,
  enableItn: boolean | undefined,
): Record<string, unknown> {
  const asrOptions: Record<string, unknown> = {};
  if (language !== undefined) asrOptions['language'] = language;
  if (enableItn !== undefined) asrOptions['enable_itn'] = enableItn;
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: audioDataUrl } }],
      },
    ],
    stream: false,
    ...(Object.keys(asrOptions).length > 0 ? { asr_options: asrOptions } : {}),
  };
}

/** 从 annotations[] 取首条合法 emotion → SttEmotion;无/非法 → undefined(纯加法、不污染)。 */
function extractEmotion(annotations: readonly AnnotationLike[] | undefined): SttEmotion | undefined {
  if (annotations === undefined) return undefined;
  for (const a of annotations) {
    const label = a.emotion;
    if (typeof label === 'string' && VALID_EMOTIONS.has(label)) {
      return { label: label as SttEmotionLabel };
    }
  }
  return undefined;
}

/** 从 annotations[] 取首条 language。 */
function extractAnnotationLanguage(
  annotations: readonly AnnotationLike[] | undefined,
): string | undefined {
  if (annotations === undefined) return undefined;
  for (const a of annotations) {
    if (typeof a.language === 'string' && a.language.length > 0) return a.language;
  }
  return undefined;
}

/** 缺省 fetch 端口:用全局 `fetch`(Node 18+ / 浏览器内置)。 */
const defaultFetch: SttFetch = (url, init) =>
  fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    ...(init.signal ? { signal: init.signal } : {}),
  }) as unknown as Promise<SttFetchResponse>;

/**
 * 把若干 PcmChunk 拼成一个 16-bit PCM WAV(RIFF/WAVE)字节流。
 * 采样率取首块(应为 16000);声道取首块(应为 1)。无块则产出 0 帧 WAV。
 * (与 openai-compat-stt 的 encodeWav 同范式;此处自带一份避免跨文件耦合,纯加法。)
 */
function encodeWav(chunks: readonly PcmChunk[]): Uint8Array {
  const sampleRate = chunks[0]?.sampleRate ?? STT_SAMPLE_RATE_HZ;
  const channels = chunks[0]?.channels ?? 1;
  let total = 0;
  for (const c of chunks) total += c.samples.length;

  const bytesPerSample = 2;
  const dataBytes = total * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  let offset = 44;
  for (const c of chunks) {
    for (let i = 0; i < c.samples.length; i++) {
      view.setInt16(offset, c.samples[i] ?? 0, true);
      offset += 2;
    }
  }
  return new Uint8Array(buf);
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** 字节 → base64(优先 Buffer;无 Buffer 环境回落 btoa)。 */
function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin);
}
