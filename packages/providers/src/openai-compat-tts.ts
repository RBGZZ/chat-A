import type { PcmChunk } from './audio';
import { TTS_SAMPLE_RATE_HZ, pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';

export interface OpenAiCompatTtsOptions {
  /** provider 标识(如 'openai' / 'kokoro-fastapi')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** 模型(如 'tts-1' / 'tts-1-hd' / 'kokoro')。 */
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.openai.com/v1'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 默认音色(可被 opts.voiceId 覆盖)。 */
  readonly voice: string;
  /** 响应格式;默认 'pcm'(直出便于流式播放)。 */
  readonly responseFormat?: 'pcm' | 'wav' | 'mp3' | 'opus';
  /** 默认语速(0.25-4.0);默认 1.0。 */
  readonly speed?: number;
  /** 输出采样率(pcm 时常为 24000)。 */
  readonly sampleRate?: number;
  readonly languages?: readonly string[];
}

/**
 * OpenAI 兼容 TTS(POST /audio/speech,pcm 流式直出)。
 *
 * 覆盖云端 OpenAI / 本地 Kokoro-FastAPI 等 OpenAI 协议端点——换 baseURL+model+key+voice 即可,
 * 系统对厂商无感(§4.3);id/model 仅供 trace。原生 fetch,无第三方依赖(与 OpenAiCompatLlm 对称)。
 *
 * 复刻:OpenAI /audio/speech **不支持** zero-shot 复刻,故 `voiceCloning=false`;
 * 请求带 refAudio 会被 assertTtsCloning fail-fast(§4.3/v2.1)。
 *
 * 容错(沿用 LLM 侧错误范式):HTTP 非 2xx / 无 body → 抛带 status/正文片段的 Error。
 */
export class OpenAiCompatTts implements TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #voice: string;
  readonly #responseFormat: NonNullable<OpenAiCompatTtsOptions['responseFormat']>;
  readonly #speed: number;
  readonly #sampleRate: number;

  constructor(opts: OpenAiCompatTtsOptions) {
    this.id = opts.id;
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#voice = opts.voice;
    this.#responseFormat = opts.responseFormat ?? 'pcm';
    this.#speed = opts.speed ?? 1.0;
    this.#sampleRate = opts.sampleRate ?? TTS_SAMPLE_RATE_HZ;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      voiceId: [opts.voice],
      sampleRate: this.#sampleRate,
      streaming: true,
      voiceCloning: false, // /audio/speech 仅内置音色,不支持 zero-shot 复刻。
    };
  }

  async *synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种 + 复刻能力。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    const res = await fetch(`${this.#baseURL}/audio/speech`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#apiKey}` },
      body: JSON.stringify({
        model: this.#model,
        voice: opts?.voiceId ?? this.#voice,
        input: text,
        response_format: this.#responseFormat,
        speed: opts?.speed ?? this.#speed,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok || res.body === null) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }

    // pcm 直出:把字节流按 Int16 边界切成 PcmChunk(跨块半样本残留进位到下一块)。
    // 非 pcm(wav/mp3/opus)需解码,留给上层(此实现仅声明并直出 pcm;非 pcm 抛错提示)。
    if (this.#responseFormat !== 'pcm') {
      throw new Error(
        `${this.id} 当前仅支持 response_format='pcm' 的流式直出;收到 '${this.#responseFormat}'(其余格式需上层解码)`,
      );
    }

    let carry: Uint8Array = new Uint8Array(0);
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      const merged = concat(carry, chunk);
      const evenLen = merged.length - (merged.length % 2);
      if (evenLen > 0) {
        yield pcmChunk(bytesToInt16(merged.subarray(0, evenLen)), this.#sampleRate);
      }
      carry = merged.subarray(evenLen);
    }
    // 收尾:若有残留奇数字节(理论不该有),丢弃(不产出半样本)。
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
