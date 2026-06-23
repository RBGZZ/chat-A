import type { PcmChunk } from './audio';
import { STT_SAMPLE_RATE_HZ } from './audio';
import { assertSttLanguage } from './stt';
import type { SttCapabilities, SttOptions, SttProvider, SttResult } from './stt';

export interface OpenAiCompatSttOptions {
  /** provider 标识(如 'openai' / 'groq-whisper')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** 模型串(如 'whisper-1' / 'gpt-4o-mini-transcribe')。 */
  readonly model: string;
  readonly apiKey: string;
  /** OpenAI 兼容端点根(如 'https://api.openai.com/v1'),末尾斜杠会被去掉。 */
  readonly baseURL: string;
  /** 默认目标语种(可被 transcribe opts 覆盖);省略 = 自动检测。 */
  readonly language?: string;
  /** 响应格式(端点 `response_format`);默认 'json'。 */
  readonly responseFormat?: 'json' | 'text' | 'verbose_json' | 'srt' | 'vtt';
  /** 采样温度;默认 0。 */
  readonly temperature?: number;
  /** 声明支持语种(能力位);默认 ['*']。 */
  readonly languages?: readonly string[];
}

/**
 * OpenAI 兼容 STT(POST /audio/transcriptions,multipart/form-data 上传 WAV)。
 *
 * 覆盖云端 OpenAI / Groq Whisper / 自托管 OpenAI 协议端点——换 baseURL + model + key 即可,
 * 系统对具体厂商无感(§4.3);id/model 仅供 trace。用原生 fetch + FormData,无第三方依赖
 * (与 OpenAiCompatLlm/OpenAiCompatEmbedder 的 fetch/容错范式对称)。
 *
 * 形态说明:批式 /audio/transcriptions **非流式**(整段上传 → 整段转写),故
 * `capabilities.streaming=false`,且只 emit 一条 `isFinal:true`(没有 partial)。
 * 实现把入口音频流**聚合为一个 WAV**再上传(真实端点要的是完整文件)。
 *
 * 容错(沿用 LLM 侧错误范式):HTTP 非 2xx → 抛带 status/正文片段的 Error。
 */
export class OpenAiCompatStt implements SttProvider {
  readonly id: string;
  readonly capabilities: SttCapabilities;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #language: string | undefined;
  readonly #responseFormat: NonNullable<OpenAiCompatSttOptions['responseFormat']>;
  readonly #temperature: number;

  constructor(opts: OpenAiCompatSttOptions) {
    this.id = opts.id;
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#language = opts.language;
    this.#responseFormat = opts.responseFormat ?? 'json';
    this.#temperature = opts.temperature ?? 0;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      streaming: false, // 批式 /audio/transcriptions:整段上传,无 partial。
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

    // 聚合音频流 → 单个 WAV(批式端点要完整文件)。
    const chunks: PcmChunk[] = [];
    for await (const c of audio) chunks.push(c);
    const wav = encodeWav(chunks);

    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', this.#model);
    form.append('response_format', this.#responseFormat);
    form.append('temperature', String(this.#temperature));
    if (language !== undefined) form.append('language', language);
    if (opts?.prompt !== undefined) form.append('prompt', opts.prompt);

    const res = await fetch(`${this.#baseURL}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#apiKey}` }, // 注意:不手设 content-type,交给 FormData 带 boundary。
      body: form,
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${this.id} HTTP ${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 500)}` : ''}`);
    }

    // 解析:text 格式直接拿正文;json/verbose_json 取 .text。
    let text: string;
    let detected: string | undefined;
    if (this.#responseFormat === 'text' || this.#responseFormat === 'srt' || this.#responseFormat === 'vtt') {
      text = (await res.text()).trim();
    } else {
      const data = (await res.json()) as { text?: string; language?: string };
      text = (data.text ?? '').trim();
      detected = data.language;
    }

    yield {
      text,
      isFinal: true,
      ...(detected !== undefined ? { language: detected } : language !== undefined ? { language } : {}),
    };
  }
}

/**
 * 把若干 PcmChunk 拼成一个 16-bit PCM WAV(RIFF/WAVE)字节流。
 * 采样率取首块(应为 16000);声道取首块(应为 1)。无块则产出 0 帧 WAV。
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
  view.setUint32(16, 16, true); // fmt chunk 大小
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true); // byte rate
  view.setUint16(32, channels * bytesPerSample, true); // block align
  view.setUint16(34, 16, true); // bits per sample
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
