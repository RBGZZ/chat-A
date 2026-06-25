import { createRequire } from 'node:module';
import type { PcmChunk } from './audio';
import { TTS_SAMPLE_RATE_HZ, pcmChunk } from './audio';
import { assertTtsCloning, assertTtsLanguage } from './tts';
import type { TtsCapabilities, TtsOptions, TtsProvider } from './tts';
import type { QwenWsLike, QwenWsFactory } from './qwen-tts-realtime';

/**
 * CosyVoice(阿里 DashScope)语音合成 —— WebSocket 流式 TTS,**DashScope `run-task` 协议**
 * (承 §4 流式优先 + §4.1 复刻音色合成 + §4.3 可换性)。
 *
 * **与 qwen-tts-realtime 协议完全不同**(别套用):
 * - 端点 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`(海外区 dashscope-intl 可覆盖);
 * - 客户端→服务端三段:`run-task`(开任务,带 model/parameters)→ 等 `task-started` →
 *   `continue-task`(送 `payload.input.text`)→ `finish-task`(收尾);全程同一 `task_id`;
 * - 服务端→客户端:JSON 文本事件经 `header.event`(task-started/result-generated/task-finished/task-failed),
 *   **音频是独立 WebSocket 二进制裸帧**(非 JSON base64),需拼接为 PcmChunk;
 * - 复刻音色 id 填 `parameters.voice`;合成 `model` 须与复刻 `target_model` 逐字一致(cosyvoice-v3.5-flash)。
 *
 * 复刻:CosyVoice **无系统音色**(必须先复刻/设计),故 `voiceCloning=true`、`voiceId` 能力列表留空。
 * 缺 voiceId 合成时 fail-fast(无内置音色可用)。
 *
 * 可测试性(R1 注入接缝):WebSocket 经注入工厂 {@link CosyVoiceWsFactory}、task_id 经注入生成器,
 * 单测注入 mock WS + 固定 id、**全程不触网且确定性**(承"勿用不可重放随机")。
 */

/** 复用通用 WS 注入端口(类型层与 qwen-tts-realtime 同构,非协议耦合)。 */
export type CosyVoiceWsLike = QwenWsLike;
export type CosyVoiceWsFactory = QwenWsFactory;
/** task_id 生成器端口(默认 crypto.randomUUID;测试注入固定值保确定性)。 */
export type TaskIdFactory = () => string;

/** 北京区默认 WebSocket 端点(海外区 dashscope-intl 可覆盖)。 */
export const COSYVOICE_TTS_ENDPOINT = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference';
/** 默认合成 model(=复刻 target_model,须逐字一致)。 */
export const COSYVOICE_TTS_DEFAULT_MODEL = 'cosyvoice-v3.5-flash';
/** 默认输出格式(裸 PCM s16le mono,直对齐 PcmChunk)。 */
export const COSYVOICE_TTS_DEFAULT_FORMAT = 'pcm';

export interface CosyVoiceTtsOptions {
  /** provider 标识(默认 'cosyvoice')——仅供 trace/日志(§8.1)。 */
  readonly id?: string;
  /** 模型 id(默认 cosyvoice-v3.5-flash;须与复刻 target_model 逐字一致)。 */
  readonly model?: string;
  /** DASHSCOPE_API_KEY;缺失/空 → 构造 fail-fast(**绝不打印**)。 */
  readonly apiKey: string;
  /** WebSocket 端点(默认北京区)。 */
  readonly endpoint?: string;
  /** 默认音色(复刻 voice_id;可被 opts.voiceId 覆盖)。CosyVoice 无系统音色,通常经 voiceId 传入。 */
  readonly voice?: string;
  /** 输出格式(默认 pcm)。 */
  readonly format?: string;
  /** 输出采样率(默认 24000)。 */
  readonly sampleRate?: number;
  /** 语速(0.5~2.0;默认服务端 1.0)。 */
  readonly rate?: number;
  /** 音调(0.5~2.0;默认服务端 1.0)。 */
  readonly pitch?: number;
  /** 音量(0~100;默认服务端 50)。 */
  readonly volume?: number;
  /**
   * 情感/风格指令(FreeStyle 自然语言,≤100 字符,汉字按 2;CosyVoice v3.5-flash/plus、v3-flash 支持)。
   * 例:'语速较快,带明显上扬语调' / '低沉一点,慢一些,带点疲惫感'。仅设置时发送(省略=不带,逐字回归)。
   * **复刻音色可叠加 instruction**(复刻专属音色 + 情感控制并用)。
   * ⚠️ 字段键名 `instruction`(单数,非 qwen-tts 的 `instructions`),WS 放 parameters.instruction(真机校准点)。
   * TODO(深度优化):未来把小雪 §6 PAD 实时心情映射成 instruction,让复刻音色随情绪说话——见
   * 记忆 cosyvoice-clone-synth-contract「情感/风格控制」,届时需开 per-call 指令(经 TtsOptions 透传)而非仅静态。
   */
  readonly instruction?: string;
  /** 是否启用 SSML 标记(parameters.enable_ssml);开启后文本写 SSML。默认不发(=false)。 */
  readonly enableSsml?: boolean;
  /** 声明支持语种(能力位);默认 ['*']。 */
  readonly languages?: readonly string[];
  /** 注入的 WS 工厂(测试用);缺省懒加载 `ws` 建真连接。 */
  readonly wsFactory?: CosyVoiceWsFactory;
  /** 注入的 task_id 生成器(测试用);缺省 crypto.randomUUID。 */
  readonly taskIdFactory?: TaskIdFactory;
}

export class CosyVoiceTts implements TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  readonly #model: string;
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #voice: string | undefined;
  readonly #format: string;
  readonly #sampleRate: number;
  readonly #rate: number | undefined;
  readonly #pitch: number | undefined;
  readonly #volume: number | undefined;
  readonly #instruction: string | undefined;
  readonly #enableSsml: boolean | undefined;
  readonly #wsFactory: CosyVoiceWsFactory;
  readonly #taskId: TaskIdFactory;

  constructor(opts: CosyVoiceTtsOptions) {
    if (typeof opts.apiKey !== 'string' || opts.apiKey.length === 0) {
      throw new Error(
        `cosyvoice 需要 DashScope API key;请设置环境变量 CHAT_A_DASHSCOPE_API_KEY(或 CHAT_A_TTS_API_KEY)`,
      );
    }
    this.id = opts.id ?? 'cosyvoice';
    this.#model = opts.model ?? COSYVOICE_TTS_DEFAULT_MODEL;
    this.#apiKey = opts.apiKey;
    this.#endpoint = opts.endpoint ?? COSYVOICE_TTS_ENDPOINT;
    this.#voice = opts.voice;
    this.#format = opts.format ?? COSYVOICE_TTS_DEFAULT_FORMAT;
    this.#sampleRate = opts.sampleRate ?? TTS_SAMPLE_RATE_HZ;
    this.#rate = opts.rate;
    this.#pitch = opts.pitch;
    this.#volume = opts.volume;
    this.#instruction = opts.instruction;
    this.#enableSsml = opts.enableSsml;
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.#taskId = opts.taskIdFactory ?? defaultTaskId;
    this.capabilities = {
      languages: opts.languages ?? ['*'],
      // CosyVoice 无系统音色:voiceId 能力列表留空(音色来自复刻),voiceCloning=true。
      sampleRate: this.#sampleRate,
      streaming: true,
      voiceCloning: true,
    };
  }

  async *synthesize(text: string, opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
    // 能力门 fail-fast(§4.3/v2.1):语种 + 复刻能力,在建连之前。
    assertTtsLanguage(this.capabilities, opts?.language);
    assertTtsCloning(this.capabilities, opts);

    // 进入即查取消:已取消则不建连、空产出。
    if (signal?.aborted === true) return;

    // CosyVoice 无系统音色:必须有 voiceId(复刻音色)。缺则 fail-fast(不建连)。
    const voice = opts?.voiceId ?? this.#voice;
    if (voice === undefined || voice.length === 0) {
      throw new Error(
        `${this.id} 需要复刻音色 voiceId(CosyVoice 无系统音色);请先复刻并配置 CHAT_A_VOICE_ID`,
      );
    }

    // 情绪/风格指令:按调用 opts.instruction 优先于构造期静态 #instruction(未给则回落静态)。
    // 支撑"随心情说话"(persona PAD → 指令逐回合注入);未配置两者均 undefined → 不发 instruction(回归)。
    const instruction = opts?.instruction ?? this.#instruction;

    const taskId = this.#taskId();
    const ws = this.#wsFactory(this.#endpoint, { Authorization: `Bearer ${this.#apiKey}` });
    const queue = new ByteFrameQueue();
    let aborted = false;
    let carry: Uint8Array = new Uint8Array(0);

    const onAbort = (): void => {
      aborted = true;
      // 收尾:发 finish-task 让服务端干净结束,然后关连接。
      safeSend(ws, JSON.stringify(buildFinishTask(taskId)));
      safeClose(ws);
      queue.finish();
    };

    ws.on('open', () => {
      // 开任务:run-task(带 model + parameters);input 必须为空对象。
      safeSend(
        ws,
        JSON.stringify(
          buildRunTask(taskId, this.#model, {
            voice,
            format: this.#format,
            sampleRate: this.#sampleRate,
            ...(this.#rate !== undefined ? { rate: this.#rate } : {}),
            ...(this.#pitch !== undefined ? { pitch: this.#pitch } : {}),
            ...(this.#volume !== undefined ? { volume: this.#volume } : {}),
            ...(instruction !== undefined ? { instruction } : {}),
            ...(this.#enableSsml !== undefined ? { enableSsml: this.#enableSsml } : {}),
          }),
        ),
      );
    });

    ws.on('message', (data: unknown, isBinary?: unknown) => {
      // 二进制音频帧(裸 PCM):直接入队。
      if (isBinary === true) {
        const bytes = toBytes(data);
        if (bytes !== undefined && bytes.length > 0) queue.push(bytes);
        return;
      }
      const evt = parseTextEvent(data);
      if (evt === undefined) {
        // 非 JSON 事件:可能是未带 isBinary 标志的音频帧(mock / 非标准实现)→ 当音频兜底。
        const bytes = toBytes(data);
        if (bytes !== undefined && bytes.length > 0) queue.push(bytes);
        return;
      }
      switch (evt.event) {
        case 'task-started':
          // 任务就绪:送全文 + 收尾。
          safeSend(ws, JSON.stringify(buildContinueTask(taskId, text)));
          safeSend(ws, JSON.stringify(buildFinishTask(taskId)));
          break;
        case 'task-finished':
          queue.finish();
          break;
        case 'task-failed':
          queue.fail(new Error(`${this.id} 服务端 task-failed: ${describeTaskError(evt)}`));
          break;
        // result-generated(sentence-begin/synthesis/end)为进度事件,音频走二进制帧,这里忽略。
        default:
          break;
      }
    });

    ws.on('error', (err: unknown) => {
      queue.fail(new Error(`${this.id} WebSocket 连接错误: ${describeErr(err)}`));
    });

    ws.on('close', (code: unknown, reason: unknown) => {
      const r = reason == null ? '' : typeof reason === 'string' ? reason : String(reason);
      queue.closeWith(typeof code === 'number' ? code : undefined, r);
    });

    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

    try {
      for (;;) {
        const next = await queue.pull();
        if (next.done) break;
        if (aborted) break;
        const merged = concat(carry, next.value);
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

// ───────────────────────────── 协议消息构造(契约可改;真机校准只改这里) ─────────────────────────────

interface RunTaskParams {
  voice: string;
  format: string;
  sampleRate: number;
  rate?: number;
  pitch?: number;
  volume?: number;
  instruction?: string;
  enableSsml?: boolean;
}

/** run-task:开任务。`payload.input` 必须为空对象(官方约定)。 */
export function buildRunTask(taskId: string, model: string, p: RunTaskParams): Record<string, unknown> {
  return {
    header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
    payload: {
      task_group: 'audio',
      task: 'tts',
      function: 'SpeechSynthesizer',
      model,
      parameters: {
        text_type: 'PlainText',
        voice: p.voice,
        format: p.format,
        sample_rate: p.sampleRate,
        ...(p.rate !== undefined ? { rate: p.rate } : {}),
        ...(p.pitch !== undefined ? { pitch: p.pitch } : {}),
        ...(p.volume !== undefined ? { volume: p.volume } : {}),
        // 情感/风格:instruction(单数键,FreeStyle 自然语言)+ enable_ssml(SSML 开关)。
        // 仅设置时发送(省略=逐字回归)。⚠️ 真机校准:instruction 确切键名(SDK 用单数 instruction)。
        ...(p.instruction !== undefined && p.instruction.length > 0
          ? { instruction: p.instruction }
          : {}),
        ...(p.enableSsml !== undefined ? { enable_ssml: p.enableSsml } : {}),
      },
      input: {},
    },
  };
}

/** continue-task:送文本(可多次;本实现一次送全文)。 */
export function buildContinueTask(taskId: string, text: string): Record<string, unknown> {
  return {
    header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: { text } },
  };
}

/** finish-task:收尾。`payload.input` 为空对象。 */
export function buildFinishTask(taskId: string): Record<string, unknown> {
  return {
    header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' },
    payload: { input: {} },
  };
}

/** 解析服务端文本事件(吃 string / Buffer→text → JSON,读 header.event)。非事件返回 undefined。 */
export function parseTextEvent(data: unknown): { event: string; [k: string]: unknown } | undefined {
  let text: string | undefined;
  if (typeof data === 'string') text = data;
  else {
    const bytes = toBytes(data);
    if (bytes === undefined) return undefined;
    try {
      text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
      return undefined;
    }
  }
  if (text === undefined) return undefined;
  try {
    const obj = JSON.parse(text) as unknown;
    if (obj !== null && typeof obj === 'object') {
      const header = (obj as { header?: unknown }).header;
      if (header !== null && typeof header === 'object') {
        const ev = (header as { event?: unknown }).event;
        if (typeof ev === 'string') {
          return { event: ev, ...(obj as Record<string, unknown>) };
        }
      }
    }
  } catch {
    /* 非 JSON 帧(如二进制音频被误当文本)→ 非事件 */
  }
  return undefined;
}

/** 从 task-failed 事件提取可读错误(不含 key)。 */
function describeTaskError(evt: { [k: string]: unknown }): string {
  const header = evt['header'];
  if (header !== null && typeof header === 'object') {
    const h = header as { error_code?: unknown; error_message?: unknown };
    const code = typeof h.error_code === 'string' ? h.error_code : '';
    const msg = typeof h.error_message === 'string' ? h.error_message : '';
    const joined = [code, msg].filter((s) => s.length > 0).join(' ');
    if (joined.length > 0) return joined.slice(0, 500);
  }
  return JSON.stringify(evt).slice(0, 500);
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/** 把 WS message 数据规整为 Uint8Array(string 不算字节,返回 undefined)。 */
function toBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return new Uint8Array(data);
  return undefined;
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 500);
  if (typeof err === 'string') return err.slice(0, 500);
  try {
    return JSON.stringify(err).slice(0, 500);
  } catch {
    return String(err).slice(0, 500);
  }
}

function safeSend(ws: CosyVoiceWsLike, data: string): void {
  try {
    ws.send(data);
  } catch {
    /* 连接已关 / 发送失败:由 error/close 路径兜底 */
  }
}

function safeClose(ws: CosyVoiceWsLike): void {
  try {
    ws.close();
  } catch {
    /* 已关闭忽略 */
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

/**
 * 事件回调 ↔ for-await 异步桥(二进制帧版:与 qwen-tts 的 base64 字符串队列同构思路,
 * 但缓冲 Uint8Array 裸字节)。
 */
class ByteFrameQueue {
  #buf: Uint8Array[] = [];
  #done = false;
  #err: Error | undefined;
  #closeCode: number | undefined;
  #closeReason = '';
  #closed = false;
  #resolve: (() => void) | undefined;

  push(bytes: Uint8Array): void {
    if (this.#done) return;
    this.#buf.push(bytes);
    this.#wake();
  }

  finish(): void {
    if (this.#done) return;
    this.#done = true;
    this.#wake();
  }

  fail(err: Error): void {
    if (this.#done) return;
    this.#err = err;
    this.#done = true;
    this.#wake();
  }

  closeWith(code: number | undefined, reason = ''): void {
    this.#closed = true;
    this.#closeCode = code;
    this.#closeReason = reason;
    if (!this.#done) this.#wake();
  }

  async pull(): Promise<{ done: true } | { done: false; value: Uint8Array }> {
    for (;;) {
      if (this.#buf.length > 0) {
        return { done: false, value: this.#buf.shift() as Uint8Array };
      }
      if (this.#err !== undefined) throw this.#err;
      if (this.#done) return { done: true };
      if (this.#closed) {
        throw new Error(
          `cosyvoice WebSocket 在合成完成前关闭${this.#closeCode !== undefined ? `(code ${this.#closeCode})` : ''}${this.#closeReason ? `:${this.#closeReason}` : ''}`,
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

/** 缺省 WS 工厂:懒加载 `ws` 包建真连接(只在真实运行时引入)。 */
const defaultWsFactory: CosyVoiceWsFactory = (url, headers) => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = createRequire(import.meta.url)('ws') as WsCtor;
  const sock = new WS(url, { headers });
  return {
    send: (data) => sock.send(data),
    close: (code, reason) => sock.close(code, reason),
    on: (event: string, cb: (...args: unknown[]) => void) => sock.on(event, cb),
  } as CosyVoiceWsLike;
};

/** 缺省 task_id 生成器:crypto.randomUUID(运行时真随机;测试注入固定值)。 */
const defaultTaskId: TaskIdFactory = () => {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  // 极少数无 crypto 环境兜底(不进热路径,仅建连一次)。
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nodeCrypto = require('node:crypto') as typeof import('node:crypto');
  return nodeCrypto.randomUUID();
};

/** ws 构造器最小面。 */
interface WsCtor {
  new (url: string, opts: { headers: Record<string, string> }): {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    on(event: string, cb: (...args: unknown[]) => void): void;
  };
}
