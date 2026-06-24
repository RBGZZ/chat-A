import { createRequire } from 'node:module';
import type { PcmChunk } from './audio';
import { TTS_SAMPLE_RATE_HZ, pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';

/**
 * Qwen(阿里 DashScope)qwen-tts-realtime —— WebSocket 全双工**流式** TTS(承 §4 流式优先 + §4.3 可换性)。
 *
 * 为什么:TTS 是嵌入式部署的真瓶颈(见 memory embedded-lightweight-strategy:TTS 而非 LLM 决定首音延迟)。
 * qwen-tts-realtime 边送文本边收音频、首音延迟低、OpenAI-Realtime 风格协议,默认输出
 * **PCM 24kHz/16bit/mono**——与项目 `PcmChunk`(`TTS_SAMPLE_RATE_HZ=24000`、Int16 mono)天然对齐。
 *
 * 协议(调研结论,见 openspec/changes/qwen-tts-realtime/design.md):
 * - 端点 `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`(海外区 dashscope-intl,可配置覆盖);
 *   鉴权请求头 `Authorization: Bearer <key>`(**绝不打印 key**)。
 * - 客户端→服务端:`session.update`(voice/response_format/mode/instructions…)→
 *   `input_text_buffer.append`(送文本)→(commit 模式)`input_text_buffer.commit` → `session.finish`;
 *   打断/丢弃用 `input_text_buffer.clear`(**无 cancel 事件**)。
 * - 服务端→客户端:`response.audio.delta`(base64 PCM 在 `delta` 字段)流式回传;
 *   `response.audio.done`/`response.done`/`session.finished` 结束;`error` 报错。
 *
 * 复刻:realtime 为**内置音色**,不支持 zero-shot 复刻,故 `voiceCloning=false`;带 refAudio → fail-fast(§4.1/v2.1)。
 *
 * 可测试性(R1 注入接缝,镜像 KokoroSession):WebSocket 经**注入工厂端口** {@link QwenWsFactory} 建立,
 * 单测注入 mock WS、**全程不触真网络**;缺省工厂在真实运行时懒加载 `ws` 包建连。
 */

/**
 * 注入式 WebSocket 端口(最小面;不把 `ws` 类型泄漏到接口签名)。
 * 真实现由缺省工厂懒加载 `ws` 包包一层;测试注入 in-memory 假 WS。
 */
export interface QwenWsLike {
  /** 发送一条文本帧(JSON 字符串)。 */
  send(data: string): void;
  /** 关闭连接(barge-in / 收尾 / 清理)。 */
  close(code?: number, reason?: string): void;
  /**
   * 注册事件回调:
   * - 'open':连接就绪(无参);
   * - 'message':收到一帧(首参为文本 JSON 或 Buffer/ArrayBuffer);
   * - 'error':连接/协议错误(首参为 err);
   * - 'close':连接关闭(首参为 code、次参为 reason)。
   *
   * 用单签名 + 宽松回调(便于 `ws` 适配 / mock 实现);各事件实参语义见上。
   */
  on(event: 'open' | 'message' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
}

/** WebSocket 工厂端口:由 url + headers 建一条连接。缺省懒加载 `ws`。 */
export type QwenWsFactory = (url: string, headers: Record<string, string>) => QwenWsLike;

/** 服务端 commit 模式(server 自动切分) / 客户端 commit 模式(显式 commit)。 */
export type QwenTtsMode = 'server_commit' | 'commit';

export interface QwenTtsRealtimeOptions {
  /** provider 标识(默认 'qwen-tts')——仅供 trace/日志(§8.1)。 */
  readonly id?: string;
  /** 模型 id(稳定别名,如 'qwen3-tts-flash-realtime' / 'qwen3-tts-instruct-flash-realtime';**别写死日期快照**)。 */
  readonly model: string;
  /** DASHSCOPE_API_KEY;缺失/空 → 构造 fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** WebSocket 端点(默认北京区;海外区 dashscope-intl 可覆盖)。 */
  readonly endpoint?: string;
  /** 默认音色(可被 opts.voiceId 覆盖,如 'Cherry'/'Chelsie'/'Serena')。 */
  readonly voice: string;
  /** 输出格式(默认 PCM 24kHz/16bit/mono,直对齐 PcmChunk)。 */
  readonly responseFormat?: string;
  /** 切分模式(默认 server_commit:服务端自动切分,免显式 commit)。 */
  readonly mode?: QwenTtsMode;
  /** 情感/风格指令(自然语言,≤1600 token;仅 instruct 版生效)。 */
  readonly instructions?: string;
  /** 输出采样率(默认 24000;与 responseFormat 一致)。 */
  readonly sampleRate?: number;
  /** 声明支持语种(能力位);默认 ['*'](多语种内置)。 */
  readonly languages?: readonly string[];
  /** 注入的 WS 工厂(测试用);缺省懒加载 `ws` 建真连接。 */
  readonly wsFactory?: QwenWsFactory;
}

/** 北京区默认 WebSocket 端点(具名常量,无 magic number;海外区见 design.md)。 */
export const QWEN_TTS_REALTIME_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
/** 默认输出格式:PCM 24kHz/16bit/mono(直对齐 PcmChunk)。 */
export const QWEN_TTS_DEFAULT_RESPONSE_FORMAT = 'PCM_24000HZ_MONO_16BIT';

export class QwenTtsRealtime implements TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #voice: string;
  readonly #responseFormat: string;
  readonly #mode: QwenTtsMode;
  readonly #instructions: string | undefined;
  readonly #sampleRate: number;
  readonly #wsFactory: QwenWsFactory;

  constructor(opts: QwenTtsRealtimeOptions) {
    if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      // 缺 key fail-fast(沿用"明确报错而非静默吞配置"):提示设环境变量。
      throw new Error(
        `qwen-tts 需要 DashScope API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或 CHAT_A_TTS_API_KEY)`,
      );
    }
    this.id = opts.id ?? 'qwen-tts';
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#endpoint = opts.endpoint ?? QWEN_TTS_REALTIME_ENDPOINT;
    this.#voice = opts.voice;
    this.#responseFormat = opts.responseFormat ?? QWEN_TTS_DEFAULT_RESPONSE_FORMAT;
    this.#mode = opts.mode ?? 'server_commit';
    this.#instructions = opts.instructions;
    this.#sampleRate = opts.sampleRate ?? TTS_SAMPLE_RATE_HZ;
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      voiceId: [opts.voice],
      sampleRate: this.#sampleRate,
      streaming: true,
      voiceCloning: false, // realtime 内置音色,不支持 zero-shot 复刻。
    };
  }

  async *synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种 + 复刻能力(带 refAudio 即拦),在建连之前。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    // 进入即查取消:已取消则不建连、空产出(与现有 TTS 一致,干净停止)。
    if (signal?.aborted === true) return;

    const voice = opts?.voiceId ?? this.#voice;

    // 建连:url 带 model query;鉴权走请求头(**不打印 key**)。
    const url = appendModelQuery(this.#endpoint, this.#model);
    const ws = this.#wsFactory(url, { Authorization: `Bearer ${this.#apiKey}` });

    // 事件 → for-await 的异步桥:音频帧入队,done/error/close 推哨兵结束。
    const queue = new FrameQueue();

    let aborted = false;
    let carry: Uint8Array = new Uint8Array(0); // 跨帧半样本残留(s16le 边界)。

    const onAbort = (): void => {
      aborted = true;
      // barge-in:发 clear + 关连接(无 cancel 事件);让迭代干净结束。
      safeSend(ws, JSON.stringify({ type: 'input_text_buffer.clear' }));
      safeClose(ws);
      queue.finish();
    };

    ws.on('open', () => {
      // 握手:session.update(voice/response_format/mode/instructions…)。
      safeSend(
        ws,
        JSON.stringify({
          type: 'session.update',
          session: {
            voice,
            response_format: this.#responseFormat,
            mode: this.#mode,
            ...(this.#instructions !== undefined ? { instructions: this.#instructions } : {}),
          },
        }),
      );
      // 送文本(append 消息体抽成可改函数,应对协议歧义,见 design.md §1.2)。
      safeSend(ws, JSON.stringify(buildAppend(text)));
      // commit 模式才需显式 commit;server_commit 由服务端自动切分。
      if (this.#mode === 'commit') {
        safeSend(ws, JSON.stringify({ type: 'input_text_buffer.commit' }));
      }
      // 结束本次合成会话:服务端据此收尾产出。
      safeSend(ws, JSON.stringify({ type: 'session.finish' }));
    });

    ws.on('message', (data) => {
      const evt = parseEvent(data);
      if (evt === undefined) return;
      switch (evt.type) {
        case 'response.audio.delta': {
          const b64 = typeof evt.delta === 'string' ? evt.delta : undefined;
          if (b64 !== undefined && b64.length > 0) queue.push(b64);
          break;
        }
        case 'response.done':
        case 'response.audio.done':
        case 'session.finished':
          queue.finish();
          break;
        case 'error':
          queue.fail(
            new Error(`${this.id} 服务端 error: ${describeServerError(evt)}`),
          );
          break;
        default:
          break;
      }
    });

    ws.on('error', (err) => {
      // 连接/协议错误 → 优雅降级:抛带上下文中文错误(不含 key)。
      queue.fail(new Error(`${this.id} WebSocket 连接错误: ${describeErr(err)}`));
    });

    ws.on('close', (code) => {
      // 正常收尾(finish 已触发)时 close 无害;未收齐就 close → 视为异常结束。
      queue.closeWith(typeof code === 'number' ? code : undefined);
    });

    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        const next = await queue.pull();
        if (next.done) break;
        if (aborted) break;
        // base64 → s16le 字节,跨帧半样本进位(沿用 openai-compat-tts 的 carry 写法)。
        const bytes = base64ToBytes(next.value);
        const merged = concat(carry, bytes);
        const evenLen = merged.length - (merged.length % 2);
        if (evenLen > 0) {
          yield pcmChunk(bytesToInt16(merged.subarray(0, evenLen)), this.#sampleRate);
        }
        carry = merged.subarray(evenLen);
      }
    } finally {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      safeClose(ws); // 务必关连接,防泄漏 / 防后台烧远端额度。
    }
  }
}

/**
 * `input_text_buffer.append` 消息体构造(抽出以应对协议歧义:`{text}` vs `{arguments:{text}}`,见 design.md §1.2)。
 * 当前采用与 OpenAI-Realtime 一致的 `{ type, text }` 形态;真机若证实需 `arguments`,改此一处即可(爆炸半径可控)。
 */
function buildAppend(text: string): Record<string, unknown> {
  return { type: 'input_text_buffer.append', text };
}

/** 给端点拼接 model query(realtime 以 query 参数携带 model)。 */
function appendModelQuery(endpoint: string, model: string): string {
  const sep = endpoint.includes('?') ? '&' : '?';
  return `${endpoint}${sep}model=${encodeURIComponent(model)}`;
}

/** 解析一帧服务端事件(吃文本 JSON / Buffer / ArrayBuffer);非 JSON 或无 type 返回 undefined。 */
function parseEvent(data: unknown): { type: string; [k: string]: unknown } | undefined {
  let text: string | undefined;
  if (typeof data === 'string') text = data;
  else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
  else if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) text = data.toString('utf8');
  if (text === undefined) return undefined;
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj !== null && typeof obj === 'object' && typeof (obj as { type?: unknown }).type === 'string') {
      return obj as { type: string; [k: string]: unknown };
    }
  } catch {
    /* 非 JSON 帧忽略 */
  }
  return undefined;
}

/** 从服务端 error 事件提取可读信息(不含 key)。 */
function describeServerError(evt: { [k: string]: unknown }): string {
  const e = evt['error'];
  if (e !== null && typeof e === 'object') {
    const o = e as { code?: unknown; message?: unknown };
    const code = typeof o.code === 'string' ? o.code : '';
    const msg = typeof o.message === 'string' ? o.message : '';
    return [code, msg].filter((s) => s.length > 0).join(' ').slice(0, 500) || JSON.stringify(e).slice(0, 500);
  }
  if (typeof evt['message'] === 'string') return (evt['message'] as string).slice(0, 500);
  return JSON.stringify(evt).slice(0, 500);
}

/** 从 WS error 回调参数提取可读信息(不含 key)。 */
function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  if (typeof err === 'string') return err.slice(0, 500);
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err).slice(0, 500);
  }
}

function safeSend(ws: QwenWsLike, data: string): void {
  try {
    ws.send(data);
  } catch {
    /* 连接已关 / 发送失败:由 error/close 事件路径兜底,不在此重复抛 */
  }
}

function safeClose(ws: QwenWsLike): void {
  try {
    ws.close();
  } catch {
    /* 已关闭忽略 */
  }
}

/** base64 → 字节(优先 Buffer;无 Buffer 环境回落 atob)。 */
function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
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

/**
 * 事件回调 ↔ for-await 异步桥:音频 base64 入队,消费者拉取;done/error 终止。
 * 单生产多帧、单消费;用 pending Promise 唤醒等待中的 pull。
 */
class FrameQueue {
  #buf: string[] = [];
  #done = false;
  #err: Error | undefined;
  #closeCode: number | undefined;
  #closed = false;
  #resolve: (() => void) | undefined;

  push(b64: string): void {
    if (this.#done) return;
    this.#buf.push(b64);
    this.#wake();
  }

  /** 正常结束(收齐音频)。 */
  finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#wake();
  }

  /** 失败结束(下次 pull 抛)。 */
  fail(err: Error): void {
    if (this.#done) return;
    this.#err = err;
    this.#done = true;
    this.#wake();
  }

  /** 连接关闭:若尚未正常 finish 且无 error,记下 code,pull 到尾时据此判异常。 */
  closeWith(code: number | undefined): void {
    this.#closed = true;
    this.#closeCode = code;
    if (!this.#done) this.#wake();
  }

  async pull(): Promise<{ done: true } | { done: false; value: string }> {
    for (;;) {
      if (this.#buf.length > 0) {
        return { done: false, value: this.#buf.shift() as string };
      }
      if (this.#err !== undefined) throw this.#err;
      if (this.#done) return { done: true };
      // 未 done 但连接已关 + buffer 空 → 异常结束(没收到 finish/done)。
      if (this.#closed) {
        throw new Error(
          `qwen-tts WebSocket 在合成完成前关闭${this.#closeCode !== undefined ? `(code ${this.#closeCode})` : ''}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.#resolve = resolve;
      });
    }
  }

  #wake(): void {
    const r = this.#resolve;
    this.#resolve = undefined;
    if (r !== undefined) r();
  }
}

/** 缺省 WS 工厂:懒加载 `ws` 包建真连接(只在真实运行时引入,不污染单测)。 */
const defaultWsFactory: QwenWsFactory = (url, headers) => {
  // 懒加载:用 require 包一层避免顶层 import 把 ws 焊进类型/测试链路。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = createRequire(import.meta.url)('ws') as WsCtor;
  const sock = new WS(url, { headers });
  return {
    send: (data) => sock.send(data),
    close: (code, reason) => sock.close(code, reason),
    on: (event: string, cb: (...args: unknown[]) => void) => sock.on(event, cb),
  } as QwenWsLike;
};

/** ws 构造器最小面(不引 @types/ws 到接口签名)。 */
interface WsCtor {
  new (url: string, opts: { headers: Record<string, string> }): {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
}
