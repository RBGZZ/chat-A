## 1. 新建 gateway 包 + 依赖

- [ ] 1.1 `packages/gateway/package.json`(`@chat-a/gateway`,依赖 `@chat-a/protocol` workspace + `ws` + `@types/ws`)、`tsconfig`(继承 `tsconfig.base.json`)
- [ ] 1.2 `pnpm install`;`pnpm --filter @chat-a/gateway typecheck` 跑通空骨架
- [ ] 1.3 在 `pnpm-workspace.yaml` 确认纳入(packages/* 通配已含)

## 2. 协议:WS 信封与控制信令

- [ ] 2.1 复用 `protocol` 泛型信封;若需新增 WS 控制 `action`(hello/heartbeat/interrupt/cursor),加到 `protocol`(与现有 BusEvent/envelope 同构,编译期类型)
- [ ] 2.2 音频帧二进制编解码(ArrayBuffer ↔ PcmFrame,含 generation/timestampMs);控制信令 JSON

## 3. WebSocketTransport 实现(两端,implements AudioTransport)

- [ ] 3.1 最小可注入 WS 接口 `GatewayWsLike` + 默认 `ws` 工厂(惰性 import;镜像 qwen-tts-realtime 可测模式)
- [ ] 3.2 终端侧 `connect(url, {wsFactory?})`:sendAudio/onAudio/clearBuffer/close;上行音频 + interrupt 信令
- [ ] 3.3 大脑侧 `accept(ws)` / server 监听:onAudio(上行)、sendAudio(下行带 generation)、clearBuffer(发 interrupt)
- [ ] 3.4 跨网络 generation:下行帧带 generation;终端丢弃不匹配迟到帧;clearBuffer 即时本地排空

## 4. 连接生命周期

- [ ] 4.1 协议版本握手(hello 交换 protocolVersion;大脑兼容 current + current-1,过旧拒绝 + 清晰中文错误)
- [ ] 4.2 应用层心跳 ping/pong + 漏 N 次判失联
- [ ] 4.3 终端指数退避重连 1s→30s + 大脑保活窗口保 session
- [ ] 4.4 优雅降级:握手失败/断网/handler 抛错隔离不崩(沿用 InProcess 容错);背压有界缓冲 + 丢帧计数
- [ ] 4.5 (接缝预留,不实装)WSS/TLS + 鉴权握手 hook;终端本地缓存提示音 hook;播放游标回传 hook

## 5. client 接入(行为即配置)

- [ ] 5.1 `voice-runner` / `cli-voice` 增传输选择:`CHAT_A_TRANSPORT=inprocess|websocket`(缺省 inprocess,逐字不变)
- [ ] 5.2 websocket 档:终端起 client transport;附说明如何另起大脑侧 server 进程(本地双进程手测指引)

## 6. 测试(mock WS,不触网)

- [ ] 6.1 上下行音频帧往返(PCM 等价:采样率/声道/timestamp)
- [ ] 6.2 generation 丢弃迟到帧 + clearBuffer 即时排空
- [ ] 6.3 协议版本握手:兼容通过 / 过旧拒绝
- [ ] 6.4 心跳失联 + 指数重连时序
- [ ] 6.5 失败降级:连接失败/handler 抛错不崩
- [ ] 6.6 配置切换:inprocess 缺省行为与变更前一致(回归)

## 7. 收尾

- [ ] 7.1 worktree 根 `pnpm -r typecheck` 全绿
- [ ] 7.2 worktree 根 `npx vitest run` 全绿(新增 + 回归)
- [ ] 7.3 自检 §3.1 接缝(AudioTransport 契约不变、runtime/cognition 零改)、§4 跨网络打断、§8 心跳/重连/版本;commit 到 worktree 分支(中文),不 push、不动 master
- [ ] 7.4 简报注明:鉴权/WSS/游标回传为接缝预留未实装;真机双进程手测步骤
