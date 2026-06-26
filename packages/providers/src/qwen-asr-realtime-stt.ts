import { createRequire } from 'node:module';
import type { PcmChunk } from './audio';
import type { SttEmotion, SttEmotionLabel } from './stt';

/**
 * Qwen 实时流式 ASR(qwen3-asr-flash-realtime)——DashScope realtime WebSocket(OpenAI-Realtime 风格)。
 * 实现 runtime 的 StreamingSttPort(结构上满足):openSession 开长连接,持续 pushAudio,服务端 VAD 连续分句,
 * 经 handlers 吐 speech_started/partial/final(带 7 类情绪)。与 qwen-omni-llm 同源 WS 范式。
 */

/** realtime WS 端点(缺省;可经 baseURL 覆盖)。 */
export const QWEN_ASR_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_QWEN_ASR_REALTIME_MODEL = 'qwen3-asr-flash-realtime';

/** 最小可注入 WS 接口(同 omni 的 OmniWsLike)。 */
export interface RealtimeWsLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: (code?: number, reason?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
export type RealtimeWsFactory = (url: string, opts: { readonly headers: Record<string, string> }) => RealtimeWsLike;

export interface QwenAsrRealtimeSttOptions {
  readonly id: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly wsFactory?: RealtimeWsFactory;
  /** server_vad 静音断句阈(ms);缺省 400(连续对话更跟手)。 */
  readonly silenceDurationMs?: number;
}

const VALID_EMOTIONS: ReadonlySet<string> = new Set([
  'surprised', 'neutral', 'happy', 'sad', 'disgusted', 'angry', 'fearful',
]);
function toEmotion(raw: unknown): SttEmotion | undefined {
  return typeof raw === 'string' && VALID_EMOTIONS.has(raw)
    ? { label: raw as SttEmotionLabel }
    : undefined;
}

/** 默认 WS 工厂:惰性 require `ws`(node),避免装配期触网/打包静态解析(对齐 qwen-omni-llm)。 */
const defaultWsFactory: RealtimeWsFactory = (url, opts) => {
  // 惰性 require:仅在真正建连时加载 ws(避免装配/注入 mock 的测试触及该包,也回避 ESM 顶层 import 的副作用)。
  const req = createRequire(import.meta.url);
  const WS = req('ws') as new (u: string, o?: { headers?: Record<string, string> }) => RealtimeWsLike;
  return new WS(url, { headers: opts.headers });
};

interface Handlers {
  onSpeechStarted(): void;
  onPartial(text: string, emotion?: SttEmotion, lang?: string): void;
  onFinal(text: string, emotion?: SttEmotion, lang?: string): void;
  onError(err: unknown): void;
}

export class QwenAsrRealtimeStt {
  readonly #model: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #wsFactory: RealtimeWsFactory;
  readonly #silenceMs: number;

  constructor(opts: QwenAsrRealtimeSttOptions) {
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    // 去尾随斜杠(与 omni / OpenAiCompatLlm 对称);拼 ?model= 时再加查询串。
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.#silenceMs = opts.silenceDurationMs ?? 400;
  }

  openSession(handlers: Handlers, opts?: { readonly language?: string }) {
    const url = `${this.#baseURL}?model=${encodeURIComponent(this.#model)}`;
    const ws = this.#wsFactory(url, {
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
    });
    let open = false;
    let closed = false;
    ws.on('open', () => { open = true; });
    ws.on('error', (err) => handlers.onError(err));
    ws.on('close', () => { closed = true; });
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        // WS message 的 data 可能是 string / Buffer / Uint8Array:统一解码为文本再 JSON 解析。
        const text = typeof data === 'string'
          ? data
          : data instanceof Uint8Array
            ? new TextDecoder().decode(data)
            : String(data);
        msg = JSON.parse(text) as Record<string, unknown>;
      } catch { return; }
      const type = msg['type'];
      if (type === 'session.created') {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            ...(opts?.language ? { input_audio_transcription: { language: opts.language } } : {}),
            turn_detection: { type: 'server_vad', silence_duration_ms: this.#silenceMs },
          },
        }));
      } else if (type === 'input_audio_buffer.speech_started') {
        handlers.onSpeechStarted();
      } else if (type === 'conversation.item.input_audio_transcription.text') {
        const text = String((msg['text'] ?? '') as string) + String((msg['stash'] ?? '') as string);
        if (text.length > 0) handlers.onPartial(text, toEmotion(msg['emotion']), msg['language'] as string | undefined);
      } else if (type === 'conversation.item.input_audio_transcription.completed') {
        const text = String((msg['transcript'] ?? '') as string);
        handlers.onFinal(text, toEmotion(msg['emotion']), msg['language'] as string | undefined);
      } else if (type === 'error' || type === 'conversation.item.input_audio_transcription.failed') {
        handlers.onError(msg['error'] ?? msg);
      }
    });

    return {
      pushAudio: (chunk: PcmChunk): void => {
        if (!open || closed) return; // 未连上/已关:静默丢弃(降级)
        const buf = Buffer.alloc(chunk.samples.length * 2);
        for (let i = 0; i < chunk.samples.length; i++) buf.writeInt16LE(chunk.samples[i] ?? 0, i * 2);
        try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') })); }
        catch { /* 推流失败不崩 */ }
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        try { ws.send(JSON.stringify({ type: 'session.finish' })); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }
      },
    };
  }
}
