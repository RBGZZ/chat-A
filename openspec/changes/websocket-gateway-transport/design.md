## Context

`AudioTransport`(`packages/protocol/src/audio-transport.ts`)已定义最小契约:`sendAudio(frame)` / `onAudio(cb)` / `clearBuffer()` / `close()`,并有 `InProcessAudioTransport` 进程内直通实现(同步/async 选项、容错隔离)。`protocol` 已有:泛型信封 `envelope.ts`(`{protocol,version,action,code,data,correlationId}`,version `0.1.0`)、A 层 `BusEvent`、PCM 约定(`pcm.ts`,16kHz/mono/Int16,10ms=320B/帧,带 `timestampMs`)、`Generation` 品牌类型(`ids.ts`)。client 侧有 `AudioDevice` 接缝 + `voice-runner.ts`(把 AudioDevice ↔ InProcessAudioTransport ↔ VoiceLoop 接起来)、`cli-voice.ts`。

缺口:无 `WebSocketTransport`、无 `gateway` 包,B 架构无法跨网络。`ws` 已在 workspace(providers 用),gateway 需自行声明。

## Goals / Non-Goals

**Goals:**
- `WebSocketTransport` 两端实现(大脑侧 server-accept、终端侧 client-connect),都满足 `AudioTransport` 契约,使 `voice-runner` 可零业务改动切换传输。
- 跨网络无条件打断:下行音频帧带 `generation`,终端丢弃不匹配迟到帧;上行 `interrupt` 控制信令即时(中断体感留终端本地、算力回收异步,§4)。
- 连接生命周期:协议版本握手(兼容当前+前1次)、心跳、指数重连(1s→30s,带保活窗口)、优雅关闭;全程 `correlationId`/`sessionId` 贯穿(§8.1)。
- 可测性:WS 可注入(端口/工厂),写不依赖真实网络的单测(mock WS,确定性驱动 open/message/close)。
- 行为即配置:`cli-voice` 经 env/config 选 `inprocess|websocket`,缺省 inprocess(逐字不变)。

**Non-Goals:**
- WSS/TLS + 终端鉴权握手(token/设备证书)= 接缝预留、本 change 留 hook 不实装(§8 P2 后段)。
- WebRTC(备选,P3)。
- 多终端并发/多 session 路由的完整网关(本 change 单终端单 session 即可,结构留扩展位)。
- 帧管线/STT/TTS 等 runtime 内部逻辑(由 autonomy-runtime-wiring 等其它 change 负责)。

## Decisions

1. **传输信封复用 `protocol` 泛型信封**:WS 帧 = `{protocol,version,action,code,data,correlationId}` 序列化。`action` 复用进程内事件名常量(一套命名贯穿 bus/WS/日志/trace,§8.1)。音频帧走二进制或 base64 data,控制信令走 JSON action。
2. **两端对称 `WebSocketTransport implements AudioTransport`**:server 侧(大脑)`accept(ws)`、client 侧(终端)`connect(url)`;均暴露同一 `sendAudio/onAudio/clearBuffer/close`。`voice-runner` 注入哪个实现由配置决定。
3. **generation 跨网络**:下行每个音频帧信封带 `generation`;终端播放前比对当前 generation,过期帧丢弃(§4 终端本地即时,0 网络延迟);`clearBuffer()` → 发 `interrupt` 控制信令 + 本地排空。
4. **WS 可注入工厂**:`wsFactory?` 构造选项(缺省惰性 `require('ws')`),测试传 FakeWs;镜像 `qwen-tts-realtime`/`qwen-omni-llm` 已验证的可测模式。
5. **协议版本握手**:连接后首帧交换 `protocolVersion`;大脑兼容 `current` 与 `current-1`,过旧明确拒绝(错误码 + 中文原因,§8)。
6. **心跳/重连**:应用层 ping/pong(WS 无强制业务心跳),漏 N 次判失联;终端指数退避重连 `[1s,2s,4s,…,30s]` + 保活窗口内大脑保 session;断网时终端播放本地缓存提示音(§8 终端最小本地资产,本 change 留接缝)。
7. **优雅降级**(§3.2):任一阶段失败不崩——握手失败/版本不符 → 清晰错误;连接断 → 重连;`onAudio` handler 抛错隔离(沿用 InProcess 容错)。

## Risks / Trade-offs

- **背压**:A 层总线不设队列(§4.2.2),WS 高频音频帧背压需在传输层处理(丢帧 + 计数,不无限堆积,§4 优雅降级语义);本 change 做有界缓冲 + 丢帧计数。
- **时钟对齐**:逐帧 `timestampMs` 已在 PCM 约定里;EOU/打断时间对齐依赖它,跨网络抖动需终端播放游标回传(§4 裸 WebSocket 缺口)——本 change 先打基础(游标回传留接缝)。
- **二进制 vs base64**:base64 简单但 +33% 带宽;二进制 WS 帧更省但解析复杂。决策:音频帧用二进制 ArrayBuffer,控制信令用 JSON——`ws` 原生支持二者。
- **鉴权延后**:本 change 不做 WSS/鉴权,仅留 hook;真部署前必须补(记入 tasks 收尾说明 + §8 P2)。
- **与并行 change 的接触面**:仅 `protocol` 可能加 WS 控制信令类型;合并时与其它 change 取并集,风险低。
