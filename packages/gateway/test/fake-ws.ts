/**
 * in-memory 假 WS 对(测试夹具):**同步驱动** open/message/close,不触真网络。
 * 一对 {@link FakeWs} 互为对端:一端 send 即在对端**同步**触发 message(便于确定性断言;
 * 真网络异步性由测试在需要处手动错开)。镜像 providers qwen-tts-realtime.test 的 MockWs 风格,
 * 但支持**二进制(Uint8Array)+ 文本**两类载荷,且为成对(client↔server)。
 */
import type { GatewayWsLike, WsSendable } from '../src/index';

export class FakeWs implements GatewayWsLike {
  peer: FakeWs | null = null;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  readonly sentText: string[] = [];
  readonly sentBinary: Uint8Array[] = [];
  readonly #cbs: { [k: string]: ((...args: unknown[]) => void)[] } = {};
  /** 是否在 send 时同步投递到对端(默认 true);置 false 则缓存,手动 flush。 */
  syncDeliver = true;
  readonly #pending: { toPeer: WsSendable }[] = [];

  send(data: WsSendable): void {
    if (this.closed) return;
    if (typeof data === 'string') this.sentText.push(data);
    else this.sentBinary.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (this.syncDeliver) this.#deliver(data);
    else this.#pending.push({ toPeer: data });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.#emit('close', code, reason);
    // 通知对端关闭(模拟 TCP 半关→对端 close)。
    const p = this.peer;
    if (p !== undefined && p !== null && !p.closed) p.close(code, reason);
  }

  on(event: 'open' | 'message' | 'error' | 'close', cb: (...args: unknown[]) => void): void {
    (this.#cbs[event] ??= []).push(cb);
  }

  // ───────────────────────────── 测试驱动 ─────────────────────────────

  /** 触发 open(测试在挂好监听后调用)。 */
  fireOpen(): void {
    this.#emit('open');
  }

  /** 触发 error(测试模拟连接错误)。 */
  fireError(err: unknown): void {
    this.#emit('error', err);
  }

  /** 缓存模式:把积压消息冲到对端(模拟迟到帧)。 */
  flush(): void {
    const items = this.#pending.splice(0);
    for (const it of items) this.#deliver(it.toPeer);
  }

  #deliver(data: WsSendable): void {
    const p = this.peer;
    if (p === null || p.closed) return;
    // 二进制以 Uint8Array 投递(模拟 ws binary message);文本以 string。
    if (typeof data === 'string') p.#emit('message', data);
    else p.#emit('message', new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const cb of [...(this.#cbs[event] ?? [])]) cb(...args);
  }
}

/** 造一对互联的 FakeWs(client↔server),都未 open(由测试控制 open 时序)。 */
export function makeFakeWsPair(): { client: FakeWs; server: FakeWs } {
  const client = new FakeWs();
  const server = new FakeWs();
  client.peer = server;
  server.peer = client;
  return { client, server };
}

/** 可注入时钟桩:手动 tick 推进所有到期定时器(确定性测心跳/重连时序)。 */
export class FakeClock {
  #t = 0;
  #timers: { at: number; fn: () => void; id: number; cancelled: boolean }[] = [];
  #seq = 0;

  now(): number {
    return this.#t;
  }

  setTimer(fn: () => void, ms: number): () => void {
    const id = this.#seq++;
    const timer = { at: this.#t + ms, fn, id, cancelled: false };
    this.#timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  }

  /** 推进时间 ms,触发期间所有到期定时器(按到期时刻顺序)。 */
  advance(ms: number): void {
    const target = this.#t + ms;
    for (;;) {
      const due = this.#timers
        .filter((t) => !t.cancelled && t.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) break;
      const next = due[0]!;
      next.cancelled = true;
      this.#t = next.at;
      this.#timers = this.#timers.filter((t) => t.id !== next.id);
      next.fn();
    }
    this.#t = target;
  }

  /** 当前未取消的定时器数(断言用)。 */
  pendingCount(): number {
    return this.#timers.filter((t) => !t.cancelled).length;
  }
}
