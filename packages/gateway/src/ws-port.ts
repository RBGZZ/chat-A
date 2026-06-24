/**
 * 注入式 WebSocket 端口(最小面;不把 `ws` 类型泄漏到接口签名)——
 * 镜像 `packages/providers/src/qwen-tts-realtime.ts` 已验证的可测模式(R1 注入接缝):
 * 真实现由缺省工厂懒加载 `ws` 包包一层;单测注入 in-memory 假 WS,**全程不触真网络**。
 *
 * 与 qwen 端口的差异:gateway 既要**发文本(JSON 控制信令)又要发二进制(音频帧)**,
 * 故 `send` 收 `string | ArrayBufferView`(`ws` 原生支持二者);`message` 回调首参可能是
 * 文本(控制信令)或 Buffer/ArrayBuffer(音频帧),解码侧据类型分流(见 codec.ts)。
 */
import { createRequire } from 'node:module';

/** 一帧可发送的载荷:控制信令走 JSON 文本,音频帧走二进制视图(§design 决策 1)。 */
export type WsSendable = string | ArrayBufferView;

/**
 * WebSocket 连接最小面(收发 + 生命周期事件)。`ws` 与 in-memory 假实现都能满足。
 * 事件实参语义:
 * - 'open':连接就绪(无参);
 * - 'message':收到一帧(首参为文本 string 或 Buffer/ArrayBuffer/Uint8Array);
 * - 'error':连接/协议错误(首参为 err);
 * - 'close':连接关闭(首参 code、次参 reason)。
 */
export interface GatewayWsLike {
  send(data: WsSendable): void;
  close(code?: number, reason?: string): void;
  on(event: 'open' | 'message' | 'error' | 'close', cb: (...args: unknown[]) => void): void;
}

/** 终端侧工厂:由 url(+ 可选 headers,鉴权接缝预留)建一条连接。缺省懒加载 `ws`。 */
export type GatewayWsFactory = (url: string, headers?: Record<string, string>) => GatewayWsLike;

/** 缺省终端侧工厂:懒加载 `ws` 包建真连接(只在真实运行时引入,不污染单测)。 */
export const defaultClientWsFactory: GatewayWsFactory = (url, headers) => {
  // 懒加载:用 createRequire 包一层,避免顶层 import 把 ws 焊进类型/测试链路。
  const WS = createRequire(import.meta.url)('ws') as WsCtor;
  const sock = headers !== undefined ? new WS(url, { headers }) : new WS(url);
  return adaptWs(sock);
};

/** 把一个 `ws` 实例适配成 {@link GatewayWsLike}(server accept 到的 ws 亦可经此适配)。 */
export function adaptWs(sock: WsInstance): GatewayWsLike {
  return {
    send: (data) => sock.send(data),
    close: (code, reason) => sock.close(code, reason),
    on: (event: string, cb: (...args: unknown[]) => void) => sock.on(event, cb),
  };
}

/** ws 实例最小面(运行期适配用;不引 @types/ws 到接口签名)。 */
export interface WsInstance {
  send(data: WsSendable): void;
  close(code?: number, reason?: string): void;
  on(event: string, cb: (...args: unknown[]) => void): void;
}

/** ws 构造器最小面。 */
interface WsCtor {
  new (url: string, opts?: { headers: Record<string, string> }): WsInstance;
}
