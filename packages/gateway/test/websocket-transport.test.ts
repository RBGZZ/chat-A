import { describe, it, expect } from 'vitest';
import {
  makeDataFrame,
  STT_AUDIO_FORMAT,
  TTS_AUDIO_FORMAT,
  type AudioFrame,
} from '@chat-a/protocol';
import {
  connectClientTransport,
  acceptServerTransport,
  encodeAudio,
  makeSignal,
  GATEWAY_PROTOCOL_VERSION,
  type GatewayWsFactory,
} from '../src/index';
import { makeFakeWsPair, FakeWs, FakeClock } from './fake-ws';

function inputFrame(samples: number[], ts = 0): AudioFrame {
  return makeDataFrame('audio:input', {
    audio: { samples: Int16Array.from(samples), sampleRate: 16000, channels: 1, timestampMs: ts },
    format: STT_AUDIO_FORMAT,
  });
}
function ttsFrame(samples: number[], seq = 0): AudioFrame {
  return makeDataFrame('tts:chunk', { format: TTS_AUDIO_FORMAT, samples: Int16Array.from(samples), seq });
}

/**
 * 接一对已握手的终端↔大脑 transport(同步 FakeWs 对 + FakeClock)。
 * 默认关心跳(heartbeatIntervalMs=0),专测时单独开。终端关重连(backoffMs=[])便于断言。
 */
function connectedPair(opts?: { heartbeatIntervalMs?: number; backoffMs?: readonly number[] }) {
  const { client: clientWs, server: serverWs } = makeFakeWsPair();
  const clock = new FakeClock();
  const heartbeatIntervalMs = opts?.heartbeatIntervalMs ?? 0;
  const backoffMs = opts?.backoffMs ?? [];

  const factory: GatewayWsFactory = () => clientWs;
  const server = acceptServerTransport(serverWs, { clock, heartbeatIntervalMs });
  const serverRecv: AudioFrame[] = [];
  server.onAudio((f) => serverRecv.push(f));

  const client = connectClientTransport('ws://brain', { wsFactory: factory, clock, heartbeatIntervalMs, backoffMs });
  const clientRecv: AudioFrame[] = [];
  client.onAudio((f) => clientRecv.push(f));

  serverWs.fireOpen();
  clientWs.fireOpen(); // 终端 open → 发 hello → 大脑校验 → 回 hello → 双方握手

  return { client, server, clientWs, serverWs, clientRecv, serverRecv, clock };
}

describe('WebSocketTransport:握手 + 上下行音频(注入 FakeWs,不触网)', () => {
  it('握手:终端 open 发 hello,大脑兼容则双方 handshakeComplete', () => {
    const { client, server } = connectedPair();
    expect(client.handshakeComplete).toBe(true);
    expect(server.handshakeComplete).toBe(true);
  });

  it('上行:终端 sendAudio → 大脑 onAudio 收到等价 PCM 帧', () => {
    const { client, serverRecv } = connectedPair();
    client.sendAudio(inputFrame([1, -1, 100], 12.5));
    expect(serverRecv.length).toBe(1);
    const f = serverRecv[0]!;
    expect(f.type).toBe('audio:input');
    if (f.type === 'audio:input') {
      expect(f.payload.audio.sampleRate).toBe(16000);
      expect(f.payload.audio.timestampMs).toBe(12.5);
      expect([...f.payload.audio.samples]).toEqual([1, -1, 100]);
    }
  });

  it('下行:大脑 sendAudio(带 generation)→ 终端 onAudio 收到', () => {
    const { server, clientRecv } = connectedPair();
    server.sendAudio(ttsFrame([7, 8, 9]));
    expect(clientRecv.length).toBe(1);
    const f = clientRecv[0]!;
    expect(f.type).toBe('tts:chunk');
    if (f.type === 'tts:chunk') expect([...f.payload.samples]).toEqual([7, 8, 9]);
  });

  it('未连接(close 后)sendAudio/onAudio 为安全 no-op,不抛', () => {
    const { client } = connectedPair();
    client.close();
    expect(() => client.sendAudio(inputFrame([1]))).not.toThrow();
    const unsub = client.onAudio(() => {});
    expect(() => unsub()).not.toThrow();
  });
});

describe('WebSocketTransport:跨网络 generation 打断', () => {
  it('终端丢弃过期帧:迟到的旧代际下行帧被丢 + 计数', () => {
    const { client, server, clientWs, clientRecv } = connectedPair();
    server.sendAudio(ttsFrame([1])); // gen 0
    expect(clientRecv.length).toBe(1);

    // 终端打断:本地自增 generation(→1)+ interrupt 上行 → 大脑也抬到 1。
    client.clearBuffer();
    expect(client.generation).toBe(1);
    expect(server.generation).toBe(1);

    // 大脑后续下行用新代际(1)→ 终端收。
    server.sendAudio(ttsFrame([2]));
    expect(clientRecv.length).toBe(2);

    // 模拟网络迟到的旧代际(gen=0)帧:直接以裸二进制喂到终端底层连接 → 被丢 + 计数。
    clientWs.peer!.send(new Uint8Array(encodeAudio(ttsFrame([99]), 0)));
    expect(clientRecv.length).toBe(2);
    expect(client.stats.droppedStaleGeneration).toBe(1);
  });

  it('打断即时排空(本地动作):终端 clearBuffer 不依赖大脑往返即抬代际', () => {
    const { client } = connectedPair();
    const before = client.generation;
    client.clearBuffer();
    expect(client.generation).toBe(before + 1); // 本地即时,0 网络延迟
  });

  it('大脑 clearBuffer 发 interrupt 下行 → 终端抬代际', () => {
    const { client, server } = connectedPair();
    server.clearBuffer();
    expect(server.generation).toBe(1);
    expect(client.generation).toBe(1);
  });
});

describe('WebSocketTransport:协议版本握手', () => {
  it('兼容版本 → 大脑接受,回 hello(code 0)', () => {
    const { server } = connectedPair();
    expect(server.handshakeComplete).toBe(true);
  });

  it('过旧版本 → 大脑拒绝(code 401 + 中文原因 close),不进入会话', () => {
    // 直接对大脑喂一条过旧版本 hello(绕开终端固定版本)。
    const ws = new FakeWs();
    const peer = new FakeWs();
    ws.peer = peer;
    peer.peer = ws;
    let rejected: number | undefined;
    const server = acceptServerTransport(ws, { heartbeatIntervalMs: 0 });
    server.onServerHandshake((sig) => {
      rejected = sig.code;
    });
    ws.fireOpen();
    // 终端侧(peer)发一条声明过旧版本的 hello。
    peer.send(JSON.stringify(makeSignal('hello', { protocolVersion: '0.0.1', role: 'client' }, 'c1')));
    expect(server.handshakeComplete).toBe(false);
    expect(rejected).toBe(401);
    // 大脑应已 close 连接(拒绝)。
    expect(ws.closed).toBe(true);
    expect(ws.closeCode).toBe(4001);
  });

  it('当前版本常量为 0.1.0(兼容窗首版)', () => {
    expect(GATEWAY_PROTOCOL_VERSION).toBe('0.1.0');
  });
});

describe('WebSocketTransport:心跳 + 失联 + 指数重连', () => {
  it('心跳:握手后定时发 ping;对端收 ping 回 pong', () => {
    const { client, clientWs, serverWs, clock } = connectedPair({ heartbeatIntervalMs: 5000 });
    expect(client.handshakeComplete).toBe(true);
    const serverSentBefore = serverWs.sentText.length;
    clock.advance(5000); // 双方各发首个 ping → 各自回 pong
    // 终端经 clientWs 发了 ping。
    const clientPings = clientWs.sentText.filter((t) => t.includes('"kind":"ping"'));
    expect(clientPings.length).toBeGreaterThanOrEqual(1);
    // 大脑收到终端 ping 后回了 pong。
    const serverPongs = serverWs.sentText.slice(serverSentBefore).filter((t) => t.includes('"kind":"pong"'));
    expect(serverPongs.length).toBeGreaterThanOrEqual(1);
  });

  it('失联:漏 N 次心跳 → 关连接(终端触发重连)', () => {
    // 终端开心跳 + 开重连;让对端不回 pong(把 server 心跳关、且断开投递)。
    const { client: clientWs, server: serverWs } = makeFakeWsPair();
    const clock = new FakeClock();
    const factory: GatewayWsFactory = () => clientWs;
    const server = acceptServerTransport(serverWs, { clock, heartbeatIntervalMs: 0 });
    server.onAudio(() => {});
    const client = connectClientTransport('ws://brain', {
      wsFactory: factory,
      clock,
      heartbeatIntervalMs: 5000,
      heartbeatMaxMissed: 2,
      backoffMs: [1000],
    });
    serverWs.fireOpen();
    clientWs.fireOpen();
    expect(client.handshakeComplete).toBe(true);

    // 断开对端投递,使终端的 ping 收不到 pong(漏拍累积)。
    clientWs.peer = null;
    const reconnectsBefore = client.stats.reconnects;
    // 漏拍:tick1(missed=1,发 ping)→ tick2(missed=2,发 ping)→ tick3(missed=3>2 超限,关连接)。
    clock.advance(5000);
    clock.advance(5000);
    clock.advance(5000);
    // 失联 → close → 终端排重连(backoff 1s)。
    clock.advance(1000);
    expect(client.stats.reconnects).toBeGreaterThan(reconnectsBefore);
  });

  it('指数重连:连接 close 后按 backoff 重连并重置退避', () => {
    const { client: clientWs } = makeFakeWsPair();
    const clock = new FakeClock();
    let created = 0;
    const factory: GatewayWsFactory = () => {
      created++;
      return clientWs;
    };
    const client = connectClientTransport('ws://brain', {
      wsFactory: factory,
      clock,
      heartbeatIntervalMs: 0,
      backoffMs: [1000, 2000],
    });
    expect(created).toBe(1);
    clientWs.fireOpen();
    // 连接断 → 排重连(1000ms)。
    clientWs.close(1006);
    clock.advance(1000);
    expect(created).toBe(2); // 已重连一次
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
  });
});

describe('WebSocketTransport:优雅降级', () => {
  it('建连工厂抛错 → 不崩,排重连', () => {
    const clock = new FakeClock();
    let calls = 0;
    const factory: GatewayWsFactory = () => {
      calls++;
      if (calls === 1) throw new Error('connect refused');
      return new FakeWs();
    };
    const client = connectClientTransport('ws://brain', {
      wsFactory: factory,
      clock,
      heartbeatIntervalMs: 0,
      backoffMs: [1000],
    });
    expect(client.stats.reconnects).toBe(1); // 首次失败即排重连
    expect(() => clock.advance(1000)).not.toThrow();
    expect(calls).toBe(2);
  });

  it('onAudio listener 抛错被隔离,不影响其它 listener / 不崩', () => {
    const { client, server } = connectedPair();
    const got: AudioFrame[] = [];
    client.onAudio(() => {
      throw new Error('listener boom');
    });
    client.onAudio((f) => got.push(f)); // 第二个 listener 仍应收到
    expect(() => server.sendAudio(ttsFrame([5]))).not.toThrow();
    expect(got.length).toBe(1);
  });

  it('WS error 事件 → 终端转重连,不抛穿透', () => {
    const { client: clientWs } = makeFakeWsPair();
    const clock = new FakeClock();
    const factory: GatewayWsFactory = () => clientWs;
    const client = connectClientTransport('ws://brain', {
      wsFactory: factory,
      clock,
      heartbeatIntervalMs: 0,
      backoffMs: [1000],
    });
    clientWs.fireOpen();
    expect(() => clientWs.fireError(new Error('ECONNRESET'))).not.toThrow();
    clock.advance(1000);
    expect(client.stats.reconnects).toBeGreaterThanOrEqual(1);
  });
});
