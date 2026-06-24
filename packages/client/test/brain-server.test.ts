import { describe, it, expect, vi } from 'vitest';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import {
  startBrainServer,
  loadGatewayPort,
  DEFAULT_GATEWAY_PORT,
  type WsServerLike,
  type BrainLoopFactoryDeps,
} from '../src/audio/brain-server';

/**
 * 大脑侧 WebSocket server 入口测试(不开真端口、不触网):
 * 注入 fake WebSocketServer + fake ws(GatewayWsLike 兼容),emit connection/close,
 * 断言「连接来了 → 建出 VoiceLoop 并 start」「close → stop」。
 */

/** 一个最小 GatewayWsLike fake(send/close/on),可手动 emit 'close'。 */
function makeFakeWs() {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
      on: (event: string, cb: (...a: unknown[]) => void) => {
        (handlers[event] ??= []).push(cb);
      },
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const cb of handlers[event] ?? []) cb(...args);
    },
  };
}

/** 一个 fake WsServerLike:可手动 emit 'connection'。 */
function makeFakeServer(): { server: WsServerLike; emitConnection: (ws: unknown) => void; closed: () => boolean } {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  let isClosed = false;
  return {
    server: {
      on: (event: string, cb: (...a: unknown[]) => void) => {
        (handlers[event] ??= []).push(cb);
      },
      close: (cb?: () => void) => {
        isClosed = true;
        cb?.();
      },
    },
    emitConnection: (ws) => {
      for (const cb of handlers['connection'] ?? []) cb(ws);
    },
    closed: () => isClosed,
  };
}

function loopDeps(sessionId: string): BrainLoopFactoryDeps {
  return {
    vad: new StubVadDetector([0.9]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt(),
    tts: new FakeTts(),
    send: async (_t: string, onToken: (s: string) => void) => {
      onToken('好。');
      return '好。';
    },
    memory: { appendMessage: vi.fn() },
    sessionId,
  };
}

describe('client/startBrainServer', () => {
  it('connection 到来 → 装配并启动 VoiceLoop(connectionCount+1);close → stop(-1)', () => {
    const fakeServer = makeFakeServer();
    const handle = startBrainServer({
      port: 8787,
      loopDepsFor: (id) => loopDeps(id),
      wsServerFactory: () => fakeServer.server,
    });
    expect(handle.connectionCount).toBe(0);

    const c1 = makeFakeWs();
    fakeServer.emitConnection(c1.ws);
    expect(handle.connectionCount).toBe(1);

    const c2 = makeFakeWs();
    fakeServer.emitConnection(c2.ws);
    expect(handle.connectionCount).toBe(2);

    // 关一条连接 → 该连接 VoiceLoop stop,计数 -1。
    c1.emit('close');
    expect(handle.connectionCount).toBe(1);

    handle.stop();
    expect(fakeServer.closed()).toBe(true);
    expect(handle.connectionCount).toBe(0);
  });

  it('某连接装配抛错 → 跳过该连接并关 ws,不拖垮 server(其它连接仍可接)', () => {
    const fakeServer = makeFakeServer();
    let first = true;
    const handle = startBrainServer({
      port: 8787,
      loopDepsFor: (id) => {
        if (first) {
          first = false;
          throw new Error('装配失败(模拟)');
        }
        return loopDeps(id);
      },
      wsServerFactory: () => fakeServer.server,
    });

    const bad = makeFakeWs();
    fakeServer.emitConnection(bad.ws); // 装配抛 → 跳过 + 关 ws
    expect(bad.ws.close).toHaveBeenCalled();
    expect(handle.connectionCount).toBe(0);

    const ok = makeFakeWs();
    fakeServer.emitConnection(ok.ws); // 第二条正常
    expect(handle.connectionCount).toBe(1);
    handle.stop();
  });

  it('端口解析:非法/缺省回落默认,合法采纳', () => {
    expect(loadGatewayPort({})).toBe(DEFAULT_GATEWAY_PORT);
    expect(loadGatewayPort({ CHAT_A_GATEWAY_PORT: 'x' })).toBe(DEFAULT_GATEWAY_PORT);
    expect(loadGatewayPort({ CHAT_A_GATEWAY_PORT: '70000' })).toBe(DEFAULT_GATEWAY_PORT);
    expect(loadGatewayPort({ CHAT_A_GATEWAY_PORT: '9000' })).toBe(9000);
  });
});
