import { createRequire } from 'node:module';
import type { PcmChunk } from './audio';

/**
 * Qwen Omni Realtime Provider —— DashScope WebSocket 实时多模态(OpenAI-Realtime 风格协议)。
 *
 * 设计依据:`openspec/changes/qwen-omni-realtime-llm/design.md`(协议已用官方文档核实)。
 *
 * **仅音频面(audio-in → 文本流)**:吃 PCM 块流 → `input_audio_buffer.append`(base64),
 * yield 判别联合事件(transcript=用户话语 / text=回复增量 / end)。这是 omni-realtime 的核心价值
 * (让模型直接「听」原始音频、感知情绪),为后续 runtime 接入 audio-in 直路(路径B)留接缝——
 * **本 change 不接 VoiceLoop**,只提供并测试此面。
 *
 * 注:早稿曾设「文本兼容面」(implements LlmProvider 的 stream/complete,用 conversation.item.create
 * + input_text 把纯文本当用户消息送入,以便当普通 LLM 直接装进 registry)。**已据官方 client-events
 * 文档核实(2026-06-24):DashScope realtime 的 conversation.item.create 当前仅接受 function_call_output
 * 类型,且音频输入是必需的——该文本路径协议上不成立,故移除。** 纯文本 LLM 走已实测可用的 OpenAI 兼容
 * `qwen` provider(见 registry.ts),与本 provider 各司其职。
 *
 * 核心约束(§3.2):
 * - **AbortSignal 真取消**:abort → 关 WS、终止生成器(承 VoiceLoop 打断 abort send 的 signal,底层真停)。
 * - **错误 fail-fast**:鉴权/连接/error 事件 → 抛清晰中文错误(供上层优雅降级回传统路径)。
 * - **WS 可注入**(工厂模式):构造接收可选 `wsFactory`,默认用 `ws` 包;测试注入 mock WS,不触网。
 * - **惰性连接**:构造期不连,首次 respondToAudio 才建连(装配不触网)。
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

/**
 * 回合切分模式:
 * - `manual`(默认):turn_detection=null,送完音频显式 `commit`+`response.create` 触发。适配
 *   VoiceLoop endpointing 已切好的**有限音频段**——确定性触发,不与服务端 VAD 双重判定、无额外静默延迟。
 * - `server_vad`:turn_detection={type:'server_vad'},由服务端 VAD 自动判端点触发(连续流场景);
 *   此模式**不发**手动 commit/response.create(否则与自动触发冲突)。
 * - `semantic_vad`:服务端语义 VAD(qwen3.5-omni 官方推荐),按语义判端点;与 server_vad 一样不发手动 commit。
 */
export type OmniTurnDetection = 'manual' | 'server_vad' | 'semantic_vad';

export interface QwenOmniLlmOptions {
  /** provider 标识(如 'qwen-omni')——仅供 trace/日志(§8.1)。 */
  readonly id: string;
  /** model id(如 'qwen3-omni-flash-realtime' / 'qwen-omni-turbo-realtime');不写死,由配置传入。 */
  readonly model: string;
  readonly apiKey: string;
  /** DashScope realtime WS 端点根(`wss://.../api-ws/v1/realtime`);可经配置覆盖。 */
  readonly baseURL: string;
  /** 系统提示(映射 session.instructions)。 */
  readonly instructions?: string;
  /** 回合切分模式默认值(缺省 'manual');每次 respondToAudio 可覆盖。 */
  readonly turnDetection?: OmniTurnDetection;
  /** 模型要求的输入采样率(Hz);缺省 16000(Qwen-Omni realtime 约定)。供装配层解耦采集率。 */
  readonly inputSampleRate?: number;
  /** WS 工厂(可注入;缺省用 `ws` 包,惰性 import 避免装配期触网)。 */
  readonly wsFactory?: OmniWsFactory;
}

/** respondToAudio 的可选参数。 */
export interface OmniAudioOptions {
  /** 系统提示覆盖(映射 session.instructions)。 */
  readonly instructions?: string;
  /** 回合切分模式覆盖(缺省取构造时默认值)。 */
  readonly turnDetection?: OmniTurnDetection;
}

/** 默认 WS 工厂:惰性包裹 `ws` 包(node 环境)。 */
const defaultWsFactory: OmniWsFactory = (url, opts) => {
  // 惰性 require:仅在真正建连时加载 ws(避免装配/注入 mock 的测试触及该包,也回避 ESM 顶层 import 的副作用)。
  const req = createRequire(import.meta.url);
  const WS = req('ws') as new (u: string, o?: { headers?: Record<string, string> }) => OmniWsLike;
  return new WS(url, { headers: opts.headers });
};

export class QwenOmniLlm {
  readonly id: string;
  readonly model: string;
  /** 模型要求的输入采样率(Hz);满足 OmniAudioPort.inputSampleRate。缺省 16000。 */
  readonly inputSampleRate: number;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #instructions: string | undefined;
  readonly #turnDetection: OmniTurnDetection;
  readonly #wsFactory: OmniWsFactory;

  constructor(opts: QwenOmniLlmOptions) {
    this.id = opts.id;
    this.model = opts.model;
    this.#apiKey = opts.apiKey;
    // 去尾随斜杠(与 OpenAiCompatLlm 对称);拼 ?model= 时再加查询串。
    this.#baseURL = opts.baseURL.replace(/\/+$/, '');
    this.#instructions = opts.instructions;
    this.#turnDetection = opts.turnDetection ?? 'manual';
    this.inputSampleRate = opts.inputSampleRate ?? 16000;
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
  }

  /** 已规整(去尾随斜杠)的 WS 端点根——仅供 trace/可测性。 */
  get baseURL(): string {
    return this.#baseURL;
  }

  // ───────────────────────────── 音频面(audio-in → 文本流)─────────────────────────────

  /**
   * audio-in 直路:吃 PCM 块流 → input_audio_buffer.append(base64),
   * yield transcript(用户话语)+ text(回复增量)+ end。供后续 runtime 接 VoiceLoop(路径B)。
   */
  respondToAudio(
    audio: AsyncIterable<PcmChunk>,
    opts?: OmniAudioOptions,
    signal?: AbortSignal,
  ): AsyncIterable<OmniEvent> {
    const instructions = opts?.instructions ?? this.#instructions;
    const turnDetection = opts?.turnDetection ?? this.#turnDetection;
    return this.#run({ instructions, audio, turnDetection }, signal);
  }

  // ───────────────────────────── 会话编排 ─────────────────────────────

  /**
   * 一次会话:建连 → session.created → session.update → 送音频 → 收事件 → response.done 关 WS。
   * 用一个事件队列把 WS 回调桥接为 async 生成器;AbortSignal abort → 关 WS、终止生成器(§3.2 真打断)。
   */
  async *#run(
    payload: {
      instructions: string | undefined;
      audio: AsyncIterable<PcmChunk>;
      turnDetection: OmniTurnDetection;
    },
    signal?: AbortSignal,
  ): AsyncIterable<OmniEvent> {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError'); // fail-fast,不建连

    const url = `${this.#baseURL}?model=${encodeURIComponent(this.model)}`;
    const ws = this.#wsFactory(url, { headers: { Authorization: `Bearer ${this.#apiKey}` } });

    // 事件桥:WS 回调 push 进队列,生成器从队列拉(背压简单,一问一答短连足够)。
    const queue = new EventQueue<OmniEvent>();
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
    }
  }

  /** 处理一条服务端事件:推进会话(session.created→发数据)、把文本/转写投递队列。 */
  #handleServerEvent(
    msg: ServerEvent,
    ws: OmniWsLike,
    payload: {
      instructions: string | undefined;
      audio: AsyncIterable<PcmChunk>;
      turnDetection: OmniTurnDetection;
    },
    queue: EventQueue<OmniEvent>,
  ): void {
    switch (msg.type) {
      case 'session.created': {
        // 配置会话:只要文本输出 + PCM 输入;turn_detection 按模式
        // (manual=null / server_vad|semantic_vad=服务端自动端点)。
        const serverManaged = payload.turnDetection === 'server_vad' || payload.turnDetection === 'semantic_vad';
        ws.send(
          JSON.stringify({
            type: 'session.update',
            session: {
              modalities: ['text'],
              input_audio_format: 'pcm',
              ...(payload.instructions !== undefined ? { instructions: payload.instructions } : {}),
              turn_detection: serverManaged ? { type: payload.turnDetection } : null,
            },
          }),
        );
        // 流式 append 音频块;manual 模式送完显式 commit+response.create,server_vad 由服务端自动触发。
        void this.#pumpAudio(payload.audio, ws, queue, payload.turnDetection);
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

  /**
   * 流式把 PCM 块经 input_audio_buffer.append 送出。
   * manual 模式:送完发 commit + response.create 触发合成(适配有限音频段)。
   * server_vad / semantic_vad 模式:不发手动触发(服务端 VAD 自动判端点,避免重复/冲突响应)。
   */
  async #pumpAudio(
    audio: AsyncIterable<PcmChunk>,
    ws: OmniWsLike,
    queue: EventQueue<OmniEvent>,
    turnDetection: OmniTurnDetection,
  ): Promise<void> {
    const serverManaged = turnDetection === 'server_vad' || turnDetection === 'semantic_vad';
    try {
      for await (const chunk of audio) {
        if (queue.ended) return;
        ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: pcmChunkToBase64(chunk) }));
      }
      if (!serverManaged) {
        ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
        ws.send(JSON.stringify({ type: 'response.create' }));
      }
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

/** PcmChunk(Int16Array)→ base64(小端 16-bit / mono,DashScope realtime 约定:16kHz 输入)。 */
function pcmChunkToBase64(chunk: PcmChunk): string {
  const samples = chunk.samples;
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i] ?? 0, true); // little-endian s16le
  }
  return Buffer.from(bytes).toString('base64');
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
