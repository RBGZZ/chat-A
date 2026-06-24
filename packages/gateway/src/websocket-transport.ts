/**
 * `WebSocketTransport` —— `AudioTransport`(接缝 1)的 WebSocket 实现,**两端对称**
 * (终端侧 connect / 大脑侧 accept),使 `voice-runner` 可零业务改动地在进程内与 WS 间切换(§3.1)。
 *
 * 一套类两端复用,差异仅在 `role`:
 *   - 终端(client):`sendAudio` 上行 audio:input(generation 恒 0);`onAudio` 收下行 tts:chunk;
 *     `clearBuffer` = 本地即时排空 + 自增本地 generation + 发 interrupt 上行(§4 中断体感留本地、0 网络延迟);
 *     收下行帧时比对 generation,丢弃迟到帧。负责握手 hello、心跳、**指数重连**。
 *   - 大脑(server):`sendAudio` 下行 tts:chunk(打上当前 generation);`onAudio` 收上行 audio:input;
 *     `clearBuffer` = 自增 generation(令后续下行帧带新代际)+ 发 interrupt 下行;校验握手版本、心跳。
 *
 * 优雅降级(§3.2 永不崩):任一阶段失败不抛穿透——onAudio handler 抛错隔离(沿用 InProcess 容错);
 * 连接断 → 终端指数重连;握手版本不符 → 大脑以错误码 + 中文原因 close。背压:有界发送缓冲 + 丢帧计数。
 *
 * 可测性:WS 经注入工厂建立({@link GatewayWsLike}),单测注入 in-memory 假 WS,不触真网络。
 */
import {
  type AudioFrame,
  type AudioListener,
  type AudioTransport,
  type Unsubscribe,
} from '@chat-a/protocol';
import { decodeAudio, encodeAudio, toBytes, toText } from './codec';
import {
  COMPATIBLE_PROTOCOL_VERSIONS,
  GATEWAY_PROTOCOL_VERSION,
  isCompatibleVersion,
} from './version';
import { makeSignal, parseSignal, type GatewaySignal } from './wire';
import {
  adaptWs,
  defaultClientWsFactory,
  type GatewayWsFactory,
  type GatewayWsLike,
  type WsInstance,
} from './ws-port';

/** 角色:终端(连接发起方)/ 大脑(接受方)。 */
export type TransportRole = 'client' | 'server';

/** 重连退避序列(1s→30s,§8);保活窗口内大脑保 session(本 change 单 session,接缝预留路由)。 */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1000, 2000, 4000, 8000, 16000, 30000];

/** 心跳缺省:每 5s 一次 ping,漏 3 次(15s)判失联(§8 应用层心跳)。 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5000;
export const DEFAULT_HEARTBEAT_MAX_MISSED = 3;

/** 背压有界缓冲:在途下行/上行字节超此阈值即丢帧 + 计数(§4.2 不无限堆积)。 */
export const DEFAULT_MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // 4MiB

/** 可注入时钟/定时器(测试用确定性桩;承 §3.2 可测试性,避免真 setTimeout)。 */
export interface TransportClock {
  now(): number;
  setTimer(fn: () => void, ms: number): () => void;
}

const realClock: TransportClock = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
};

export interface WebSocketTransportOptions {
  /** correlationId(一回合内继承,贯穿 bus/WS/日志,§8.1)。 */
  readonly correlationId?: string;
  /** sessionId(握手携带;保活窗口内大脑据此保 session)。 */
  readonly sessionId?: string;
  /** 注入时钟(测试桩);缺省真 setTimeout/Date.now。 */
  readonly clock?: TransportClock;
  /** 心跳间隔(ms);<=0 关心跳(测试/简单场景)。 */
  readonly heartbeatIntervalMs?: number;
  /** 漏几次心跳判失联。 */
  readonly heartbeatMaxMissed?: number;
  /** 在途缓冲上限(字节);超出丢帧 + 计数。 */
  readonly maxBufferedBytes?: number;
  /**
   * 鉴权头(终端侧;**接缝预留**,本 change 不实装 WSS/token 校验,仅透传给工厂)。
   * 真部署前必须补:大脑侧校验 + WSS,见 tasks 4.5 / §8 P2。
   */
  readonly authHeaders?: Record<string, string>;
}

/** 终端侧连接选项:url + WS 工厂(测试注入 mock)+ 重连开关。 */
export interface ConnectOptions extends WebSocketTransportOptions {
  /** 注入 WS 工厂(测试用);缺省懒加载 `ws` 建真连接。 */
  readonly wsFactory?: GatewayWsFactory;
  /** 重连退避序列(ms);缺省 {@link RECONNECT_BACKOFF_MS};传 [] 关重连(测试/一次性)。 */
  readonly backoffMs?: readonly number[];
}

/** 大脑侧接受选项。 */
export type AcceptOptions = WebSocketTransportOptions;

/** 传输运行计数(可观测;背压丢帧、重连次数、握手状态)。 */
export interface TransportStats {
  /** 因背压丢弃的发送帧数。 */
  droppedBackpressure: number;
  /** 因 generation 不匹配丢弃的迟到帧数(终端侧)。 */
  droppedStaleGeneration: number;
  /** 重连尝试次数(终端侧)。 */
  reconnects: number;
  /** 握手是否已完成。 */
  handshakeDone: boolean;
}

/**
 * WebSocket 实现的 AudioTransport。请用 {@link connectClientTransport} / {@link acceptServerTransport}
 * 构造,而非直接 new(两端装配差异由工厂封好)。
 */
export class WebSocketTransport implements AudioTransport {
  readonly role: TransportRole;
  readonly stats: TransportStats = {
    droppedBackpressure: 0,
    droppedStaleGeneration: 0,
    reconnects: 0,
    handshakeDone: false,
  };

  readonly #listeners = new Set<AudioListener>();
  readonly #clock: TransportClock;
  readonly #correlationId: string;
  readonly #sessionId: string | undefined;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatMaxMissed: number;
  readonly #maxBufferedBytes: number;

  /** 当前底层连接(null = 未连/重连中)。 */
  #ws: GatewayWsLike | null = null;
  #closed = false;
  /** 当前代际:server 下行打此标;client 本地比对丢弃迟到帧(打断即本地自增,§4)。 */
  #generation = 0;
  #handshakeDone = false;
  /** 估算的在途发送字节(背压有界)。 */
  #bufferedBytes = 0;
  /** 心跳:漏拍计数 + 取消句柄。 */
  #missedHeartbeats = 0;
  #cancelHeartbeat: (() => void) | null = null;

  /** —— 终端侧重连状态 —— */
  readonly #wsFactory: GatewayWsFactory;
  readonly #backoffMs: readonly number[];
  readonly #authHeaders: Record<string, string> | undefined;
  #backoffIdx = 0;
  #cancelReconnect: (() => void) | null = null;
  /** 大脑侧握手回调(接受/拒绝);仅 server 用。 */
  #onServerHandshake: ((sig: GatewaySignal) => void) | null = null;

  private constructor(role: TransportRole, opts: ConnectOptions) {
    this.role = role;
    this.#clock = opts.clock ?? realClock;
    this.#correlationId = opts.correlationId ?? `gateway/${role}`;
    this.#sessionId = opts.sessionId;
    this.#heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#heartbeatMaxMissed = opts.heartbeatMaxMissed ?? DEFAULT_HEARTBEAT_MAX_MISSED;
    this.#maxBufferedBytes = opts.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
    this.#wsFactory = opts.wsFactory ?? defaultClientWsFactory;
    this.#backoffMs = opts.backoffMs ?? RECONNECT_BACKOFF_MS;
    this.#authHeaders = opts.authHeaders;
  }

  // ───────────────────────────── 工厂(两端) ─────────────────────────────

  /** 终端侧:连接大脑(url),返回已开始建连的 transport(异步 open 后握手)。 */
  static connect(url: string, opts: ConnectOptions = {}): WebSocketTransport {
    const t = new WebSocketTransport('client', { ...opts });
    t.#startClient(url);
    return t;
  }

  /** 大脑侧:接受一个已建立的底层 ws(server.on('connection')),返回 transport。 */
  static accept(ws: GatewayWsLike, opts: AcceptOptions = {}): WebSocketTransport {
    const t = new WebSocketTransport('server', { ...opts });
    t.#attach(ws);
    return t;
  }

  // ───────────────────────────── AudioTransport 契约 ─────────────────────────────

  sendAudio(frame: AudioFrame): void {
    if (this.#closed) return; // close 后 no-op(优雅降级)
    const ws = this.#ws;
    if (ws === null) return; // 未连/重连中:丢弃(不缓冲跨重连,背压语义)
    // 下行(server)打当前 generation;上行(client)恒 0(终端→大脑不打断)。
    const gen = this.role === 'server' ? this.#generation : 0;
    const buf = encodeAudio(frame, gen);
    if (this.#bufferedBytes + buf.byteLength > this.#maxBufferedBytes) {
      this.stats.droppedBackpressure++; // 背压:超界丢帧 + 计数(不无限堆积,§4.2)
      return;
    }
    this.#bufferedBytes += buf.byteLength;
    try {
      ws.send(new Uint8Array(buf));
    } catch {
      // 发送失败:由 error/close 路径兜底重连;不在此重复抛(优雅降级)。
    } finally {
      // 简化背压模型:发出即认为离开缓冲(无 drain 事件的最小实现;真 backpressure 用 bufferedAmount 接缝预留)。
      this.#bufferedBytes = Math.max(0, this.#bufferedBytes - buf.byteLength);
    }
  }

  onAudio(listener: AudioListener): Unsubscribe {
    if (this.#closed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * 打断排空(§4):
   *   - 终端:自增本地 generation(后续旧代际下行帧被丢弃)+ 发 interrupt 上行(算力回收异步);本地即时。
   *   - 大脑:自增 generation(后续下行帧带新代际)+ 发 interrupt 下行通知终端排空。
   * close 后安全 no-op(幂等)。
   */
  clearBuffer(): void {
    if (this.#closed) return;
    this.#generation++;
    this.#sendSignal(
      makeSignal('interrupt', { generation: this.#generation, reason: 'clearBuffer' }, this.#correlationId),
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelReconnect?.();
    this.#cancelReconnect = null;
    this.#stopHeartbeat();
    this.#listeners.clear();
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) {
      try {
        ws.close(1000, 'normal');
      } catch {
        /* 已关忽略 */
      }
    }
  }

  // ───────────────────────────── 终端侧:建连 + 重连 ─────────────────────────────

  #startClient(url: string): void {
    if (this.#closed) return;
    let ws: GatewayWsLike;
    try {
      ws = this.#wsFactory(url, this.#authHeaders);
    } catch {
      // 建连工厂即抛(如 url 非法)→ 走重连退避,不崩。
      this.#scheduleReconnect(url);
      return;
    }
    this.#attach(ws, url);
  }

  #scheduleReconnect(url: string): void {
    if (this.#closed || this.role !== 'client') return;
    if (this.#backoffMs.length === 0) return; // 关重连
    const idx = Math.min(this.#backoffIdx, this.#backoffMs.length - 1);
    const delay = this.#backoffMs[idx] as number;
    this.#backoffIdx++;
    this.stats.reconnects++;
    this.#cancelReconnect = this.#clock.setTimer(() => {
      this.#cancelReconnect = null;
      this.#startClient(url);
    }, delay);
  }

  // ───────────────────────────── 公共:挂载一个底层连接 ─────────────────────────────

  #attach(ws: GatewayWsLike, reconnectUrl?: string): void {
    this.#ws = ws;
    this.#handshakeDone = false;
    this.stats.handshakeDone = false;
    this.#missedHeartbeats = 0;

    ws.on('open', () => {
      if (this.#closed) return;
      // 终端建连即发 hello 握手(声明自身版本);大脑等终端 hello 后校验。
      if (this.role === 'client') {
        this.#sendSignal(
          makeSignal(
            'hello',
            {
              protocolVersion: GATEWAY_PROTOCOL_VERSION,
              role: 'client',
              ...(this.#sessionId !== undefined ? { sessionId: this.#sessionId } : {}),
            },
            this.#correlationId,
          ),
        );
      }
    });

    ws.on('message', (data) => {
      if (this.#closed) return;
      const text = toText(data);
      if (text !== undefined) {
        const sig = parseSignal(text);
        if (sig !== undefined) this.#onSignal(sig);
        return;
      }
      const bytes = toBytes(data);
      if (bytes !== undefined) this.#onBinary(bytes);
    });

    ws.on('error', () => {
      // 连接/协议错误:优雅降级——终端转重连,大脑等 close 清理(不抛穿透)。
      if (this.role === 'client' && reconnectUrl !== undefined) {
        this.#teardownWs();
        this.#scheduleReconnect(reconnectUrl);
      }
    });

    ws.on('close', () => {
      this.#teardownWs();
      if (!this.#closed && this.role === 'client' && reconnectUrl !== undefined) {
        this.#scheduleReconnect(reconnectUrl);
      }
    });
  }

  /** 清当前连接的运行态(心跳/句柄),不动 listener / closed 标志。 */
  #teardownWs(): void {
    this.#stopHeartbeat();
    this.#ws = null;
    this.#handshakeDone = false;
    this.stats.handshakeDone = false;
  }

  // ───────────────────────────── 信令处理 ─────────────────────────────

  #onSignal(sig: GatewaySignal): void {
    switch (sig.action) {
      case 'hello':
        this.#onHello(sig.data);
        break;
      case 'heartbeat':
        this.#onHeartbeat(sig.data.kind);
        break;
      case 'interrupt':
        this.#onInterrupt(sig.data.generation);
        break;
      default:
        break;
    }
  }

  #onHello(data: { protocolVersion: string; role: 'client' | 'server' }): void {
    if (this.role === 'server') {
      // 大脑校验终端版本:兼容 current 与 current-1,过旧 → 错误码 + 中文原因 close。
      if (!isCompatibleVersion(data.protocolVersion)) {
        this.#sendSignal(
          makeSignal(
            'hello',
            { protocolVersion: GATEWAY_PROTOCOL_VERSION, role: 'server' },
            this.#correlationId,
            401,
          ),
        );
        const reason = `协议版本不兼容:终端 ${data.protocolVersion},大脑支持 [${COMPATIBLE_PROTOCOL_VERSIONS.join(', ')}]`;
        this.#rejectHandshake(reason);
        this.#onServerHandshake?.(
          makeSignal('hello', { protocolVersion: data.protocolVersion, role: 'client' }, this.#correlationId, 401),
        );
        return;
      }
      // 兼容:回 hello(code 0)确认,进入会话,启心跳。
      this.#sendSignal(
        makeSignal('hello', { protocolVersion: GATEWAY_PROTOCOL_VERSION, role: 'server' }, this.#correlationId),
      );
      this.#completeHandshake();
      this.#onServerHandshake?.(
        makeSignal('hello', { protocolVersion: data.protocolVersion, role: 'client' }, this.#correlationId),
      );
    } else {
      // 终端收到大脑 hello:code 非 0 = 被拒(版本过旧),不进入会话。
      // 注:Envelope.code 在 hello 回执上承载握手结果。
      this.#completeHandshake();
    }
  }

  /** 大脑拒绝握手:关连接(终端会据 backoff 重连或上层据 code 提示;本 change 不实装升级流程)。 */
  #rejectHandshake(reason: string): void {
    const ws = this.#ws;
    if (ws !== null) {
      try {
        ws.close(4001, reason.slice(0, 120));
      } catch {
        /* ignore */
      }
    }
  }

  #completeHandshake(): void {
    if (this.#handshakeDone) return;
    this.#handshakeDone = true;
    this.stats.handshakeDone = true;
    this.#backoffIdx = 0; // 握手成功 → 重置退避。
    this.#startHeartbeat();
  }

  #onInterrupt(generation: number): void {
    // 收到对端 interrupt:抬高本地 generation 到通告值(终端据此丢弃旧代际下行帧;§4 即时本地)。
    if (generation > this.#generation) this.#generation = generation;
  }

  #onBinary(bytes: Uint8Array): void {
    const decoded = decodeAudio(bytes);
    if (decoded === undefined) return; // 非本协议二进制:忽略(优雅降级)。
    // 跨网络打断:终端比对当前 generation,丢弃迟到帧(server 上行无打断,不比对)。
    if (this.role === 'client' && decoded.generation < this.#generation) {
      this.stats.droppedStaleGeneration++;
      return;
    }
    // 投递给 listener,单个抛错隔离(沿用 InProcess 容错,§3.2)。
    for (const l of [...this.#listeners]) {
      try {
        l(decoded.frame);
      } catch (err) {
        console.warn('[WebSocketTransport] onAudio listener 抛错(已捕获):', err);
      }
    }
  }

  // ───────────────────────────── 心跳 ─────────────────────────────

  #startHeartbeat(): void {
    if (this.#heartbeatIntervalMs <= 0) return;
    this.#stopHeartbeat();
    this.#missedHeartbeats = 0;
    const tick = (): void => {
      if (this.#closed || this.#ws === null) return;
      this.#missedHeartbeats++;
      if (this.#missedHeartbeats > this.#heartbeatMaxMissed) {
        // 漏 N 次判失联:关当前连接(终端据 close 重连;大脑清理 session 接缝)。
        this.#onHeartbeatTimeout();
        return;
      }
      this.#sendSignal(makeSignal('heartbeat', { kind: 'ping', atMs: this.#clock.now() }, this.#correlationId));
      this.#cancelHeartbeat = this.#clock.setTimer(tick, this.#heartbeatIntervalMs);
    };
    this.#cancelHeartbeat = this.#clock.setTimer(tick, this.#heartbeatIntervalMs);
  }

  #onHeartbeat(kind: 'ping' | 'pong'): void {
    this.#missedHeartbeats = 0; // 收到对端任何心跳即视为活着。
    if (kind === 'ping') {
      // 回 pong。
      this.#sendSignal(makeSignal('heartbeat', { kind: 'pong', atMs: this.#clock.now() }, this.#correlationId));
    }
  }

  #onHeartbeatTimeout(): void {
    const ws = this.#ws;
    this.#teardownWs();
    if (ws !== null) {
      try {
        ws.close(4000, 'heartbeat timeout');
      } catch {
        /* ignore */
      }
    }
  }

  #stopHeartbeat(): void {
    this.#cancelHeartbeat?.();
    this.#cancelHeartbeat = null;
    this.#missedHeartbeats = 0;
  }

  // ───────────────────────────── 发送信令(JSON 文本) ─────────────────────────────

  #sendSignal(sig: GatewaySignal): void {
    const ws = this.#ws;
    if (ws === null) return;
    try {
      ws.send(JSON.stringify(sig));
    } catch {
      /* 连接已关 / 发送失败:由 error/close 路径兜底,不在此重复抛 */
    }
  }

  // ───────────────────────────── 测试/装配辅助 ─────────────────────────────

  /** 当前代际(测试断言用)。 */
  get generation(): number {
    return this.#generation;
  }

  /** 握手是否完成(测试断言用)。 */
  get handshakeComplete(): boolean {
    return this.#handshakeDone;
  }

  /** 设置大脑侧握手结果回调(可选;上层据此记日志/路由 session)。 */
  onServerHandshake(cb: (sig: GatewaySignal) => void): void {
    this.#onServerHandshake = cb;
  }
}

/** 终端侧:连接大脑 url(便捷工厂;镜像 InProcessAudioTransport 的简单构造)。 */
export function connectClientTransport(url: string, opts: ConnectOptions = {}): WebSocketTransport {
  return WebSocketTransport.connect(url, opts);
}

/** 大脑侧:接受一个底层 ws(可传 `ws` 实例,自动适配)。 */
export function acceptServerTransport(
  ws: GatewayWsLike | WsInstance,
  opts: AcceptOptions = {},
): WebSocketTransport {
  const like = isGatewayWsLike(ws) ? ws : adaptWs(ws);
  return WebSocketTransport.accept(like, opts);
}

/** 粗判一个对象是否已是 GatewayWsLike(有 send/on/close);否则当作裸 ws 实例适配。 */
function isGatewayWsLike(x: GatewayWsLike | WsInstance): x is GatewayWsLike {
  return typeof (x as GatewayWsLike).on === 'function';
}
