import { createRequire } from 'node:module';
import type { LlmProvider, LlmRequest } from './llm';
import type { PcmChunk } from './audio';

/**
 * Qwen Omni Realtime Provider —— DashScope WebSocket 实时多模态(OpenAI-Realtime 风格协议)。
 *
 * 设计依据:`openspec/changes/qwen-omni-realtime-llm/design.md`(协议已用官方文档核实)。
 *
 * 两个表面:
 * - **文本兼容面**(implements {@link LlmProvider} 的 `stream`/`complete`):把文本 prompt 经 WS
 *   (`modalities:["text"]`)送出、聚合 `response.text.delta` 回吐字符串流。使其可**直接装进 registry
 *   当作普通 LLM 用**,VoiceLoop 现有 STT→文本LLM 路径**零改**即可替换(承 v3 §一:Omni 是网关 Provider)。
 * - **真多模态面** {@link respondToAudio}:吃 PCM 块流 → `input_audio_buffer.append`(base64),
 *   yield 判别联合事件(transcript=用户话语 / text=回复增量 / end),为后续 runtime 接入 audio-in
 *   直路留接缝(本 change 不接 VoiceLoop)。
 *
 * 核心约束(§3.2):
 * - **AbortSignal 真取消**:abort → 关 WS、终止生成器(承 VoiceLoop 打断 abort send 的 signal,底层真停)。
 * - **能力门 fail-fast**:鉴权/连接/error 事件 → 抛清晰中文错误(供上层优雅降级回传统路径)。
 * - **WS 可注入**(工厂模式):构造接收可选 `wsFactory`,默认用 `ws` 包;测试注入 mock WS,不触网。
 * - **惰性连接**:构造期不连,首次 stream/complete/respondToAudio 才建连(装配不触网)。
 */

/** 真多模态面的产出事件(判别联合,承 §4 流式贯穿)。 */
export type OmniEvent =
  /** 用户输入音频的转写(源自 conversation.item.input_audio_transcription.completed)。 */
  | { readonly type: 'transcript'; readonly text: string }
  /** 模型回复的文本增量(源自 response.text.delta / response.audio_transcript.delta)。 */
  | { readonly type: 'text'; readonly text: string }
  /** 本轮回复结束(源自 response.done / response.completed)。 */
  | { readonly type: 'end' };

/**
 * 最小可注入 WS 接口(只取本 Provider 用到的成员)。
 * 默认实现包裹 `ws` 包;测试可注入 FakeWs,确定性、不触网。
 */
export interface OmniWsLike {
  /** 事件监听:'open' / 'message'(data) / 'error'(err) / 'close'(code?, reason?)。 */
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: (code?: number, reason?: unknown) => void): void;
  /** 发送一帧(本 Provider 发 JSON 字符串)。 */
  send(data: string): void;
  /** 关闭连接(幂等;清理用)。 */
  close(): void;
}

/** WS 工厂:由 URL + 鉴权 header 建连(可注入)。 */
export type OmniWsFactory = (url: string, opts: { readonly headers: Record<string, string> }) => OmniWsLike;

export interface QwenOmniLlmOptions {
  /** provider 标识(如 'qwen-omni')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** model id(如 'qwen3.5-omni-flash-realtime');不写死,由配置传入。 */
  readonly model: string;
  readonly apiKey: string;
  /** DashScope realtime WS 端点根(`wss://.../api-ws/v1/realtime`);可经配置覆盖。 */
  readonly baseURL: string;
  /** 系统提示(映射 session.instructions);缺省由 LlmRequest.system 提供。 */
  readonly instructions?: string;
  /** WS 工厂(可注入;缺省用 `ws` 包,惰性 import 避免装配期触网)。 */
  readonly wsFactory?: OmniWsFactory;
}

/** respondToAudio 的可选参数。 */
export interface OmniAudioOptions {
  /** 系统提示覆盖(映射 session.instructions)。 */
  readonly instructions?: string;
}

/** 默认 WS 工厂:惰性包裹 `ws` 包(node 环境)。 */
const defaultWsFactory: OmniWsFactory = (url, opts) => {
  // 惰性 require:仅在真正建连时加载 ws(避免装配/注入 mock 的测试触及该包,也回避 ESM 顶层 import 的副作用)。
  const req = createRequire(import.meta.url);
  const WS = req('ws') as new (u: string, o?: { headers?: Record<string, string> }) => OmniWsLike;
  return new WS(url, { headers: opts.headers });
};

export class QwenOmniLlm implements LlmProvider {
  readonly id: string;
  readonly model: string;
  /** omni realtime 文本面不走 Anthropic/OpenAI function-calling 工具通道。 */
  readonly supportsTools = false;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #instructions: string | undefined;
  readonly #wsFactory: OmniWsFactory;

  constructor(opts: QwenOmniLlmOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    // 去尾随斜杠(与 OpenAiCompatLlm 对称);拼 ?model= 时再加查询串。
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#instructions = opts.instructions;
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
  }

  /** 已规整(去尾随斜杠)的 WS 端点根——仅供 trace/可测性。 */
  get baseURL(): string {
    return this.#baseURL;
  }

  // ───────────────────────────── 文本兼容面(LlmProvider)─────────────────────────────

  /** 文本流式:把 prompt 经 WS(modalities:["text"])送出,聚合 response.text.delta 回吐。 */
  async *stream(req: LlmRequest, signal?: AbortSignal): AsyncIterable<string> {
    const instructions = this.#instructions ?? req.system;
    const userText = lastUserText(req);
    for await (const ev of this.#run({ instructions, userText, audio: null }, signal)) {
      if (ev.type === 'text') yield ev.text;
    }
  }

  /** 非流式:聚合 stream 为整串(承 §3.3 厂商无感)。 */
  async complete(req: LlmRequest, signal?: AbortSignal): Promise<string> {
    let out = '';
    for await (const t of this.stream(req, signal)) out += t;
    return out;
  }

  // ───────────────────────────── 真多模态面(audio-in → 文本流)─────────────────────────────

  /**
   * audio-in 直路:吃 PCM 块流 → input_audio_buffer.append(base64),
   * yield transcript(用户话语)+ text(回复增量)+ end。供后续 runtime 接 VoiceLoop。
   */
  respondToAudio(
    audio: AsyncIterable<PcmChunk>,
    opts?: OmniAudioOptions,
    signal?: AbortSignal,
  ): AsyncIterable<OmniEvent> {
    const instructions = opts?.instructions ?? this.#instructions;
    return this.#run({ instructions, userText: null, audio }, signal);
  }

  // ───────────────────────────── 会话编排 ─────────────────────────────

  /**
   * 一次会话:建连 → session.created → session.update → 送文本/音频 → 收事件 → response.done 关 WS。
   * 用一个事件队列把 WS 回调桥接为 async 生成器;AbortSignal abort → 关 WS、终止生成器(§3.2 真打断)。
   */
  async *#run(
    payload: { instructions: string | undefined; userText: string | null; audio: AsyncIterable<PcmChunk> | null },
    signal?: AbortSignal,
  ): AsyncIterable<OmniEvent> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError'); // fail-fast,不建连

    const url = `${this.#baseURL}?model=${encodeURIComponent(this.model)}`;
    const ws = this.#wsFactory(url, { headers: { Authorization: `Bearer ${this.#apiKey}` } });

    // 事件桥:WS 回调 push 进队列,生成器从队列拉(背压简单,一问一答短连足够)。
    const queue = new EventQueue<OmniEvent>();
    let opened = false;
    let closed = false;

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      try {
        ws.close();
      } catch {
        /* 关 WS 幂等不抛(§3.2) */
      }
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      // 打断:关 WS + 终止生成器(底层 WS 流真停,不再后台跑)。
      cleanup();
      queue.fail(new DOMException('aborted', 'AbortError'));
    };
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });

    ws.on('open', () => {
      opened = true;
      // 等 session.created 再发数据(部分实现 open 即可发,但以 session.created 为准更稳)。
    });
    ws.on('error', (err) => {
      queue.fail(new Error(`qwen-omni WS 连接错误: ${describeErr(err)}`));
      cleanup();
    });
    ws.on('close', (code) => {
      if (closed) return;
      // 非正常关闭(未收 response.done 就 close)视为错误,供上层降级。
      if (!queue.ended) queue.fail(new Error(`qwen-omni WS 意外关闭${code !== undefined ? ` (code ${code})` : ''}`));
      cleanup();
    });
    ws.on('message', (data) => {
      const msg = parseMessage(data);
      if (msg === undefined) return; // 非法帧:跳过,不中断流(§3.2 容错)
      this.#handleServerEvent(msg, ws, payload, queue);
    });

    try {
      for await (const ev of queue.drain()) {
        yield ev;
        if (ev.type === 'end') break; // 收到 end 即收尾(drain 已在 end 后标记结束)
      }
    } finally {
      cleanup();
      void opened; // opened 仅用于调试/未来心跳;此处显式 void 以满足 noUnusedLocals 风格
    }
  }

  /** 处理一条服务端事件:推进会话(session.created→发数据)、把文本/转写投递队列。 */
  #handleServerEvent(
    msg: ServerEvent,
    ws: OmniWsLike,
    payload: { instructions: string | undefined; userText: string | null; audio: AsyncIterable<PcmChunk> | null },
    queue: EventQueue<OmniEvent>,
  ): void {
    switch (msg.type) {
      case 'session.created': {
        // 配置会话:只要文本输出 + PCM 输入;turn_detection 用服务端 VAD(音频面)。
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text'],
              input_audio_format: 'pcm',
              ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
              ...(payload.audio !== null
                ? { turn_detection: { type: 'server_vad' } }
                : { turn_detection: null }),
            },
          }),
        );
        // 文本面:直接发用户文本内容项 + response.create。
        if (payload.userText !== null) {
          ws.send(
            JSON.stringify({
              type: 'conversation.item.create',
              item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: payload.userText }] },
            }),
          );
          ws.send(JSON.stringify({ type: 'response.create' }));
        }
        // 音频面:流式 append 音频块(server_vad 自动触发 response,或末尾 commit 兜底)。
        if (payload.audio !== null) {
          void this.#pumpAudio(payload.audio, ws, queue);
        }
        return;
      }
      case 'response.text.delta':
      case 'response.audio_transcript.delta': {
        const delta = msg.delta;
        if (typeof delta === 'string' && delta.length > 0) queue.push({ type: 'text', text: delta });
        return;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = msg.transcript;
        if (typeof t === 'string' && t.length > 0) queue.push({ type: 'transcript', text: t });
        return;
      }
      case 'response.done':
      case 'response.completed': {
        queue.push({ type: 'end' });
        queue.end();
        return;
      }
      case 'error': {
        queue.fail(new Error(`qwen-omni 服务端错误: ${describeServerError(msg)}`));
        return;
      }
      default:
        return; // 其余事件(session.updated / speech_started 等)本 change 不消费
    }
  }

  /** 流式把 PCM 块经 input_audio_buffer.append 送出;送完 commit(手动兜底,server_vad 时无害)。 */
  async #pumpAudio(audio: AsyncIterable<PcmChunk>, ws: OmniWsLike, queue: EventQueue<OmniEvent>): Promise<void> {
    try {
      for await (const chunk of audio) {
        if (queue.ended) return;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmChunkToBase64(chunk) }));
      }
      // 送完:commit + response.create(server_vad 模式下若已自动触发则为幂等冗余,DashScope 容忍)。
      ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      ws.send(JSON.stringify({ type: 'response.create' }));
    } catch (err) {
      queue.fail(new Error(`qwen-omni 送音频失败: ${describeErr(err)}`));
    }
  }
}

// ───────────────────────────── 辅助:事件队列(WS 回调 → async 生成器)─────────────────────────────

/**
 * 单生产者(WS 回调)→ 单消费者(生成器)的异步队列。
 * push 投递、end 正常收尾、fail 以错误收尾;drain() 产出 async 迭代器。
 */
class EventQueue<T> {
  #buf: T[] = [];
  #ended = false;
  #error: unknown = undefined;
  #wake: (() => void) | null = null;

  get ended(): boolean {
    return this.#ended || this.#error !== undefined;
  }

  push(item: T): void {
    if (this.#ended || this.#error !== undefined) return;
    this.#buf.push(item);
    this.#wakeup();
  }

  end(): void {
    if (this.#error !== undefined) return;
    this.#ended = true;
    this.#wakeup();
  }

  fail(err: unknown): void {
    if (this.#ended || this.#error !== undefined) return;
    this.#error = err;
    this.#wakeup();
  }

  #wakeup(): void {
    const w = this.#wake;
    this.#wake = null;
    if (w !== null) w();
  }

  async *drain(): AsyncIterable<T> {
    for (;;) {
      while (this.#buf.length > 0) {
        yield this.#buf.shift() as T;
      }
      if (this.#error !== undefined) throw this.#error;
      if (this.#ended) return;
      await new Promise<void>((resolve) => {
        this.#wake = resolve;
      });
    }
  }
}

// ───────────────────────────── 辅助:协议编解码 ─────────────────────────────

/** 服务端事件最小形状(只取本 Provider 读的字段)。 */
interface ServerEvent {
  readonly type: string;
  readonly delta?: unknown;
  readonly transcript?: unknown;
  readonly error?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
}

/** WS message 帧 → ServerEvent(支持 string / Buffer / {data} 包裹;非法返回 undefined)。 */
function parseMessage(data: unknown): ServerEvent | undefined {
  let text: string | undefined;
  if (typeof data === 'string') text = data;
  else if (data instanceof Uint8Array) text = new TextDecoder().decode(data);
  else if (typeof data === 'object' && data !== null && 'data' in data) {
    const inner = (data as { data: unknown }).data;
    if (typeof inner === 'string') text = inner;
    else if (inner instanceof Uint8Array) text = new TextDecoder().decode(inner);
  }
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as ServerEvent;
    return typeof parsed === 'object' && parsed !== null && typeof parsed.type === 'string' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** PcmChunk(Int16Array)→ base64(小端 16-bit / mono,DashScope realtime 约定)。 */
function pcmChunkToBase64(chunk: PcmChunk): string {
  const samples = chunk.samples;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i] ?? 0, true); // little-endian s16le
  }
  return Buffer.from(bytes).toString('base64');
}

/** 取 LlmRequest 末条用户消息文本(omni 文本面只送当前轮 prompt;历史由 instructions/上层维护)。 */
function lastUserText(req: LlmRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m !== undefined && m.role === 'user') return m.content;
  }
  // 无 user 消息:退化为拼接全部 content(尽量不空送)。
  return req.messages.map((m) => m.content).join('\n');
}

function describeErr(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function describeServerError(msg: ServerEvent): string {
  const e = msg.error;
  if (typeof e === 'object' && e !== null) {
    const obj = e as { message?: unknown; code?: unknown };
    const m = typeof obj.message === 'string' ? obj.message : '';
    const c = typeof obj.code === 'string' ? obj.code : '';
    return [c, m].filter((s) => s.length > 0).join(' ') || JSON.stringify(e);
  }
  if (typeof msg.message === 'string') return msg.message;
  return describeErr(e);
}
