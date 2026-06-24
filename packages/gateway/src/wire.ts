/**
 * gateway 线协议(承 design 决策 1/5):**控制信令走 JSON,音频帧走二进制**。
 *
 * - 控制信令复用 `protocol` 的泛型信封 `Envelope<TAction, TData>`(一套命名贯穿 bus/WS/日志,§8.1):
 *   `hello`(版本握手)、`heartbeat`(应用层 ping/pong)、`interrupt`(打断,带新 generation)。
 *   这些 action 是 **gateway 传输层私有**信令(非 A 层 BusEvent),故定义在本包,不污染 protocol 的
 *   BusEventMap;仍复用同一信封结构,保持序列化/字段同构。
 * - 音频帧走**二进制**(避免 base64 +33% 带宽,§design 决策 / Risks):紧凑头(generation/timestamp/
 *   方向/格式)+ Int16 样本载荷,见 codec.ts。
 *
 * 协议版本:沿用 `protocol` 的 `PROTOCOL_VERSION`;大脑兼容 current 与 current-1(§8)。
 */
import { PROTOCOL_NAME, PROTOCOL_VERSION, type Envelope } from '@chat-a/protocol';

/** gateway 控制信令 action 名 → data 形状(传输层私有,不上 A 层总线)。 */
export interface GatewaySignalMap {
  /** 握手:终端连上后首帧声明自身 protocolVersion;大脑回 hello 表示接受(或以 close+错误码拒绝)。 */
  hello: { readonly protocolVersion: string; readonly role: 'client' | 'server'; readonly sessionId?: string };
  /** 应用层心跳:`ping` 由任一端发,对端回 `pong`(漏 N 次判失联,§8)。 */
  heartbeat: { readonly kind: 'ping' | 'pong'; readonly atMs: number };
  /** 打断:终端发起或大脑下达;携带打断后的新 generation,终端据此丢弃旧帧(§4)。 */
  interrupt: { readonly generation: number; readonly reason: string };
}

export type GatewaySignalAction = keyof GatewaySignalMap;

/** gateway 控制信令信封判别联合(复用 protocol 泛型信封)。 */
export type GatewaySignal = {
  [A in GatewaySignalAction]: Envelope<A, GatewaySignalMap[A]>;
}[GatewaySignalAction];

/** 造一条控制信令信封(复用 protocol 信封结构;correlationId 一回合内继承,§8.1)。 */
export function makeSignal<A extends GatewaySignalAction>(
  action: A,
  data: GatewaySignalMap[A],
  correlationId: string,
  code = 0,
): Envelope<A, GatewaySignalMap[A]> {
  return { protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION, action, code, correlationId, data };
}

const SIGNAL_ACTIONS: ReadonlySet<string> = new Set<string>(['hello', 'heartbeat', 'interrupt']);

/** 守卫:解析一条文本帧为 gateway 控制信令;非法/非本协议返回 undefined(优雅降级,不抛)。 */
export function parseSignal(text: string): GatewaySignal | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  if (o['protocol'] !== PROTOCOL_NAME) return undefined;
  if (typeof o['action'] !== 'string' || !SIGNAL_ACTIONS.has(o['action'])) return undefined;
  return obj as GatewaySignal;
}
