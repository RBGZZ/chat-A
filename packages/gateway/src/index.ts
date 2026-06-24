/**
 * `@chat-a/gateway` —— 终端↔大脑的 WebSocket 音频/控制通道(承 docs §1/§2 B 方案 / §8)。
 *
 * 对外接缝:`WebSocketTransport`(两端 implements `AudioTransport`,接缝 1)+ 便捷工厂
 * `connectClientTransport`(终端) / `acceptServerTransport`(大脑)。线协议(信封 + 二进制音频帧)
 * 与版本协商一并导出,便于上层组网/可观测。鉴权/WSS/游标回传为**接缝预留**(见 websocket-transport.ts)。
 */
export * from './ws-port';
export * from './wire';
export * from './codec';
export * from './version';
export * from './websocket-transport';
