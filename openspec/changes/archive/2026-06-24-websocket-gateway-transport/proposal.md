## Why

权威设计(`docs/chat-a-canonical-design.md` §1/§2)锁定 **B 方案(客户端-服务端分离)**:终端只收发音频,"大脑"在服务端/PC。但当前 `AudioTransport`(接缝 1)只有进程内实现 `InProcessAudioTransport`,**`WebSocketTransport` 与 `gateway` 包尚不存在**——终端与大脑无法真正跨网络分离,P2 的网络分离整块缺失(§9-P2 头号缺口)。

本变更补齐这条最基础的网络接缝,使同一套 runtime/cognition 代码在「进程内单机」与「WebSocket 分离 B」两种形态零业务改动切换(§3 不变量),并把设计 §4/§8 的跨网络硬要求落地:**每帧带 generation 标签的无条件打断**、心跳 + 指数重连、协议版本握手。

## What Changes

- **新建 `packages/gateway` 包**:WebSocket 连接管理、session、协议版本握手、(接缝层预留)鉴权。
- **`WebSocketTransport` 实现 `AudioTransport` 接缝**(大脑侧 server + 终端侧 client 两端),复用 `protocol` 的泛型信封 `{protocol,version,action,code,data,correlationId}` 与 PCM 帧约定。
- **跨网络 generation 标签**:下行音频帧携带 `generation`,终端丢弃不匹配的迟到帧;上行 `interrupt` 控制信令即时回传(§4 中断体感留终端本地)。
- **心跳 + 指数重连**(终端↔大脑,1s→30s,保活窗口)与协议版本协商(兼容当前 + 前 1 次,§8)。
- **client 接入**:`cli-voice` / `voice-runner` 可经配置选 `InProcess` 或 `WebSocket` 传输(行为即配置),缺省仍 InProcess(零行为变更)。

## Capabilities

### New Capabilities
- `gateway-transport`: 终端↔大脑的 WebSocket 音频/控制通道——`AudioTransport` 的 WS 实现、连接生命周期(握手/心跳/重连/优雅关闭)、跨网络 generation 打断、协议版本协商。

### Modified Capabilities
<!-- 无既有 spec 的 REQUIREMENT 变更;AudioTransport 接缝契约不变,仅新增实现。 -->

## Impact

- **新增**:`packages/gateway/**`(server 侧)、client 侧 `WebSocketTransport`、`packages/gateway/package.json`(依赖 `ws`)。
- **改动**:`packages/client`(传输选择接缝,缺省不变)、可能在 `packages/protocol` 增补 WS 控制信令类型(与现有信封/BusEvent 同构)。
- **不动**:`runtime`/`cognition`/`memory`/`persona` 业务核心(接缝隔离,§3.1)。
- **依赖**:`ws`(已在 workspace,gateway 包需各自声明)。
- **降级**:连接失败/断网 → 指数重连 + 终端本地缓存提示音(§8),绝不硬崩。
- **并行安全**:主体为新包,与其它三个并行 change(interaction/runtime/memory)无文件重叠;仅 `protocol` 可能有少量新增类型,合并取并集。
