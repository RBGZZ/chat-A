/**
 * 大脑侧 WebSocket Server 入口(runtime-assembly-wiring,承 §1/§2 B 方案)。
 *
 * 终端侧已就位(见 cli-voice.ts `startTerminalWebsocketMode`:device + `connectClientTransport`
 * + `runTerminalBridge`)。本模块补**大脑侧**:监听端口,`connection` 事件里经
 * `acceptServerTransport(ws)` 得大脑侧 {@link AudioTransport},装配 STT/TTS/VAD/EOU + `send`
 * 闭包 + {@link LightVoiceBus} 喂给一个 {@link VoiceLoop} 并 `start()`。
 *
 * 大脑侧**无本地 AudioDevice**:VoiceLoop 内部把 tts:chunk 经 `transport.sendAudio` 回灌,
 * 终端侧 `runTerminalBridge` 收下行 tts:chunk 播放——故大脑侧零设备依赖(承 §2)。
 *
 * 可测不触网(R1 注入接缝,镜像 gateway/qwen 已验证模式):`wsServerFactory` 可注入;
 * 缺省懒加载 `ws` 的 `WebSocketServer`;单测注入 fake server + fake ws,断言「connection→建
 * VoiceLoop 并 start」「close→stop」,**不开真端口**。
 *
 * 默认 `CHAT_A_TRANSPORT=inprocess`,cli 不起本 server;既有单进程链路逐字不变。
 */
import { stdout } from 'node:process';
import { createRequire } from 'node:module';
import { acceptServerTransport, type GatewayWsLike } from '@chat-a/gateway';
import { LightVoiceBus, VoiceLoop } from '@chat-a/runtime';
import type { VoiceLoopDeps } from '@chat-a/runtime';

/** 大脑侧默认监听端口(对齐终端 `DEFAULT_GATEWAY_URL` 的 ws://127.0.0.1:8787)。 */
export const DEFAULT_GATEWAY_PORT = 8787;

/** 解析监听端口:`CHAT_A_GATEWAY_PORT`,非法/缺省回落默认(1..65535 整数)。 */
export function loadGatewayPort(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env['CHAT_A_GATEWAY_PORT'] ?? '', 10);
  return Number.isInteger(raw) && raw > 0 && raw <= 65535 ? raw : DEFAULT_GATEWAY_PORT;
}

/** WebSocket Server 最小面(注入用;`ws` 的 `WebSocketServer` 与 fake 都满足)。 */
export interface WsServerLike {
  /** 'connection' 事件:首参为新连接(GatewayWsLike 兼容的 socket)。 */
  on(event: 'connection' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
  /** 关闭 server(停止接受新连接)。 */
  close(cb?: () => void): void;
}

/** Server 工厂:据端口建一个 WsServerLike。缺省懒加载 `ws` 的 WebSocketServer。 */
export type WsServerFactory = (port: number) => WsServerLike;

/** ws WebSocketServer 构造器最小面(运行期适配;不引 @types/ws 到签名)。 */
interface WsServerCtor {
  new (opts: { port: number }): {
    on(event: string, cb: (...args: unknown[]) => void): void;
    close(cb?: () => void): void;
  };
}

/** 缺省 server 工厂:懒加载 `ws` 包建真 WebSocketServer(只在真实运行时引入,不污染单测)。 */
export const defaultWsServerFactory: WsServerFactory = (port) => {
  const mod = createRequire(import.meta.url)('ws') as { WebSocketServer: WsServerCtor };
  const wss = new mod.WebSocketServer({ port });
  return {
    on: (event, cb) => wss.on(event, cb),
    close: (cb) => wss.close(cb),
  };
};

/** 大脑侧每条连接装配 VoiceLoop 所需依赖(STT/TTS/VAD/EOU/send/memory 由 cli/调用方注入)。 */
export type BrainLoopFactoryDeps = Omit<VoiceLoopDeps, 'transport' | 'bus'>;

export interface StartBrainServerDeps {
  /** 监听端口。 */
  readonly port: number;
  /**
   * 每条连接的 VoiceLoop 依赖工厂:返回除 transport/bus 外的全部依赖
   * (transport=acceptServerTransport 得,bus=本 server 每连接新建)。
   * 工厂化以便每条连接拿独立 sessionId / 新鲜 send 闭包。
   */
  readonly loopDepsFor: (connectionId: string) => BrainLoopFactoryDeps;
  /** Server 工厂(可注入;缺省懒加载 ws)。 */
  readonly wsServerFactory?: WsServerFactory;
}

/** 大脑侧 server 运行句柄:停 = 关 server + 停所有在跑的 VoiceLoop。 */
export interface BrainServerHandle {
  /** 当前活跃连接数(测试/状态行用)。 */
  readonly connectionCount: number;
  stop(): void;
}

/**
 * 启动大脑侧 WebSocket server。每条 `connection`:
 *   acceptServerTransport(ws) → 装配 VoiceLoop(注入 STT/TTS/VAD/EOU/send/memory + 新 bus)→ start。
 * 连接 `close` → 对应 VoiceLoop stop + 清理。任一连接装配失败仅告警,不拖垮 server(§3.2)。
 */
export function startBrainServer(deps: StartBrainServerDeps): BrainServerHandle {
  const factory = deps.wsServerFactory ?? defaultWsServerFactory;
  const wss = factory(deps.port);

  /** 活跃连接:连接 socket → 其 VoiceLoop 收尾函数。 */
  const live = new Set<() => void>();
  let seq = 0;

  wss.on('connection', (...args: unknown[]) => {
    const ws = args[0] as GatewayWsLike;
    const connectionId = `brain-${++seq}`;
    let loop: VoiceLoop | undefined;
    try {
      const transport = acceptServerTransport(ws);
      const bus = new LightVoiceBus();
      const loopDeps = deps.loopDepsFor(connectionId);
      loop = new VoiceLoop({ ...loopDeps, transport, bus });
      loop.start();
    } catch (err) {
      stdout.write(
        `[大脑] 连接 ${connectionId} 装配失败(已跳过该连接):${err instanceof Error ? err.message : String(err)}\n`,
      );
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      return;
    }

    const teardown = (): void => {
      try {
        loop?.stop();
      } catch {
        /* ignore */
      }
    };
    live.add(teardown);
    ws.on('close', () => {
      teardown();
      live.delete(teardown);
    });
  });

  wss.on('error', (...args: unknown[]) => {
    const err = args[0];
    stdout.write(`[大脑] server 错误:${err instanceof Error ? err.message : String(err)}\n`);
  });

  let stopped = false;
  return {
    get connectionCount(): number {
      return live.size;
    },
    stop: () => {
      if (stopped) return;
      stopped = true;
      for (const teardown of live) teardown();
      live.clear();
      try {
        wss.close();
      } catch {
        /* ignore */
      }
    },
  };
}
