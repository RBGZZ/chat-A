import type { PcmChunk } from './audio';
import { pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';

/**
 * GPT-SoVITS(本地 zero-shot 音色复刻,HTTP API)—— 真引擎(承 §4.1 音色复刻 v2.1 + §4.3 可换性)。
 *
 * 为什么:音色复刻是「小雪」长期伴侣感的关键——同一把声音贯穿始终。接缝(TtsProvider +
 * TtsCapabilities.voiceCloning + TtsRefAudio + 能力门)与配置(GptSovitsTtsConfig)早已就位,
 * 本类把 tts-registry 的 'gpt-sovits' 桩接成真:POST /tts 流式裸 PCM → PcmChunk。
 *
 * API(调研结论,详见 openspec/changes/gpt-sovits-engine/design.md;**以所部署版本为准**):
 * - 端点 `POST {baseURL}/tts`,JSON body:`text`/`text_lang`/`ref_audio_path`/`prompt_text`/
 *   `prompt_lang`/`text_split_method`/`media_type`/`streaming_mode`(采样参数本期走服务端默认)。
 * - `media_type='raw'` + `streaming_mode=true` → 分块返回**裸 PCM(s16le mono)**;采样率随模型
 *   (GPT-SoVITS v2 常见 32000Hz),不在响应里自描述,故以 config.sampleRate 为准写入每块。
 * - 错误:非 2xx 多为 JSON `{message, exception}`;读 body 片段拼进中文错误。
 *
 * 复刻:`voiceCloning=true`——`assertTtsCloning` 放行带 refAudio 的请求(本引擎的核心价值)。
 *
 * 可测试性(R1 注入接缝,镜像 KokoroSession/QwenWsFactory):fetch 经**注入端口**(缺省 globalThis.fetch),
 * 单测注入 mock fetch、**全程不触网**。
 */

/** 注入式 fetch 端口(最小面;不把 DOM lib 类型泄漏到接口签名)。缺省用 globalThis.fetch。 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: AsyncIterable<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface GptSoVitsTtsOptions {
  /** provider 标识(默认 'gpt-sovits')——仅供 trace/日志(§8.1)。 */
  readonly id?: string;
  /** API 端点根(默认 'http://127.0.0.1:9880'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 默认目标语种(端点 `text_lang`;可被 opts.language 覆盖)。 */
  readonly textLang?: string;
  /** 默认参考音频路径(端点 `ref_audio_path`;可被 opts.refAudio.source 覆盖)。 */
  readonly refAudioPath?: string;
  /** 默认参考文本(端点 `prompt_text`;可被 opts.refAudio.refText 覆盖)。 */
  readonly promptText?: string;
  /** 默认参考语种(端点 `prompt_lang`;可被 opts.refAudio.refLang 覆盖)。 */
  readonly promptLang?: string;
  /** 文本切分方法(端点 `text_split_method`,如 'cut5')。 */
  readonly textSplitMethod?: string;
  /** 是否流式(端点 `streaming_mode`);默认 true。 */
  readonly stream?: boolean;
  /** 输出采样率(GPT-SoVITS v2 常为 32000;按部署实际设)。默认 32000。 */
  readonly sampleRate?: number;
  /** 预注册复刻音色 id 列表(能力位 voiceId)。 */
  readonly voiceId?: readonly string[];
  /** 是否要求 CUDA(能力位,§4.3 能力门 / §5.6)。 */
  readonly requiresCuda?: boolean;
  /** 声明支持语种(能力位);默认 ['*'](多语种)。 */
  readonly languages?: readonly string[];
  /** 注入的 fetch(测试用);缺省用 globalThis.fetch。 */
  readonly fetch?: FetchLike;
}

/** GPT-SoVITS 默认端点根。 */
export const GPT_SOVITS_DEFAULT_BASE_URL = 'http://127.0.0.1:9880';
/** GPT-SoVITS v2 常见输出采样率(裸 PCM s16le mono);按部署模型实际可覆盖。 */
export const GPT_SOVITS_DEFAULT_SAMPLE_RATE = 32_000;

export class GptSoVitsTts implements TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  readonly #baseURL: string;
  readonly #textLang: string | undefined;
  readonly #refAudioPath: string | undefined;
  readonly #promptText: string | undefined;
  readonly #promptLang: string | undefined;
  readonly #textSplitMethod: string | undefined;
  readonly #stream: boolean;
  readonly #sampleRate: number;
  readonly #fetch: FetchLike;

  constructor(opts: GptSoVitsTtsOptions) {
    this.id = opts.id ?? 'gpt-sovits';
    this.#baseURL = (opts.baseURL || GPT_SOVITS_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#textLang = opts.textLang;
    this.#refAudioPath = opts.refAudioPath;
    this.#promptText = opts.promptText;
    this.#promptLang = opts.promptLang;
    this.#textSplitMethod = opts.textSplitMethod;
    this.#stream = opts.stream ?? true;
    this.#sampleRate = opts.sampleRate ?? GPT_SOVITS_DEFAULT_SAMPLE_RATE;
    // 缺省 fetch:绑 globalThis(避免 illegal invocation),适配最小面端口类型。
    this.#fetch = opts.fetch ?? ((url, init) => (globalThis.fetch as unknown as FetchLike)(url, init));
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      ...(opts.voiceId !== undefined ? { voiceId: opts.voiceId } : {}),
      sampleRate: this.#sampleRate,
      streaming: true,
      ...(opts.requiresCuda !== undefined ? { requiresCuda: opts.requiresCuda } : {}),
      voiceCloning: true, // GPT-SoVITS 核心:zero-shot 音色复刻。
    };
  }

  async *synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种 + 复刻能力,在建请求之前。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    // 进入即查取消:已取消则不发请求、空产出(与现有 TTS 一致,干净停止)。
    if (isAborted(signal)) return;

    // 参考音色:opts.refAudio 优先,config 默认回落。
    const ref = opts?.refAudio;
    const refSource = ref?.source ?? this.#refAudioPath;
    if (refSource === undefined) {
      throw new Error(
        `${this.id} 缺少参考音频:GPT-SoVITS /tts 必须有 ref_audio_path。请配置 refAudioPath 或传 opts.refAudio.source`,
      );
    }
    if (typeof refSource !== 'string') {
      // 内联 PcmChunk 需先落盘为服务端可访问路径,本期不支持(留作后续扩展)。
      throw new Error(
        `${this.id} 暂不支持内联 PcmChunk 作参考音频;请传可被 GPT-SoVITS 服务访问的本地路径字符串`,
      );
    }

    const textLang = opts?.language ?? this.#textLang ?? 'auto';
    const promptText = ref?.refText ?? this.#promptText;
    const promptLang = ref?.refLang ?? this.#promptLang;

    const body: Record<string, unknown> = {
      text,
      text_lang: textLang,
      ref_audio_path: refSource,
      streaming_mode: this.#stream,
      media_type: 'raw', // 裸 PCM:无 WAV 头,直按 Int16 边界流式切块。
      ...(promptText !== undefined ? { prompt_text: promptText } : {}),
      ...(promptLang !== undefined ? { prompt_lang: promptLang } : {}),
      ...(this.#textSplitMethod !== undefined ? { text_split_method: this.#textSplitMethod } : {}),
    };

    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.#fetch(`${this.#baseURL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      // fetch 抛错:AbortError 视为正常取消(干净结束);其余抛清晰中文错。
      if (isAbortError(err)) return;
      throw new Error(`${this.id} 请求 GPT-SoVITS 失败: ${describeErr(err)}`);
    }

    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`,
      );
    }

    // 流式裸 PCM(s16le mono):按 Int16 边界切 PcmChunk,跨块半样本残留进位(沿用 openai-compat-tts 写法)。
    let carry: Uint8Array = new Uint8Array(0);
    try {
      for await (const chunk of res.body) {
        if (isAborted(signal)) break;
        const merged = concat(carry, chunk);
        const evenLen = merged.length - (merged.length % 2);
        if (evenLen > 0) {
          yield pcmChunk(bytesToInt16(merged.subarray(0, evenLen)), this.#sampleRate);
        }
        carry = merged.subarray(evenLen);
      }
    } catch (err) {
      // 流读取中断:取消(AbortError)视为正常结束;其余抛清晰中文错。
      if (isAbortError(err) || isAborted(signal)) return;
      throw new Error(`${this.id} 读取 GPT-SoVITS 音频流失败: ${describeErr(err)}`);
    }
    // 收尾:残留奇数字节(理论不该有)丢弃,不产半样本。
  }
}

/**
 * 读取 signal 当前是否已取消。
 * 抽成函数:`aborted` 是可变属性,内联 `signal?.aborted === true` 会被 TS 控制流误窄为常量,
 * 经函数读取规避该误判,且每次都拿最新值(AbortController 中途可翻转)。
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/** 判定是否为取消错误(fetch 因 AbortSignal 中断)。 */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === 'AbortError' || /abort/i.test(err.message))
  );
}

/** 从错误提取可读信息。 */
function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  if (typeof err === 'string') return err.slice(0, 500);
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err).slice(0, 500);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** 小端字节 → Int16Array(s16le)。 */
function bytesToInt16(bytes: Uint8Array): Int16Array {
  const n = bytes.length >> 1;
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}
