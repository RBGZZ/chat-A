## ADDED Requirements

### Requirement: WebSocket 实现 AudioTransport 接缝

系统 SHALL 提供 `WebSocketTransport`,在大脑侧(server)与终端侧(client)两端均满足 `AudioTransport` 契约(`sendAudio` / `onAudio` / `clearBuffer` / `close`),使 `voice-runner` 可零业务改动地在进程内与 WebSocket 两种传输间切换。

#### Scenario: 终端经 WebSocket 上行音频帧,大脑收到
- **WHEN** 终端侧 `WebSocketTransport.sendAudio(frame)` 发送一个 16kHz/mono/Int16 PCM 帧
- **THEN** 大脑侧 `WebSocketTransport` 的 `onAudio` 回调收到等价的 PCM 帧(采样率/声道/时间戳一致)

#### Scenario: 大脑下行合成音频帧,终端收到并播放
- **WHEN** 大脑侧 `sendAudio(ttsFrame)` 下发带 generation 标签的合成音频帧
- **THEN** 终端侧 `onAudio` 收到该帧用于播放

#### Scenario: 传输切换为配置项
- **WHEN** 配置选择 `inprocess`(缺省)
- **THEN** `voice-runner` 使用 `InProcessAudioTransport`,行为与本变更前逐字一致

### Requirement: 跨网络无条件打断(generation 标签)

系统 SHALL 在下行音频帧的信封中携带 `generation`,终端 SHALL 丢弃与当前 generation 不匹配的迟到帧;`clearBuffer()` SHALL 触发上行 `interrupt` 控制信令并令终端本地立即排空缓冲。

#### Scenario: 终端丢弃过期帧
- **WHEN** 终端当前 generation 为 N,收到 generation 为 N-1 的迟到音频帧
- **THEN** 终端丢弃该帧,不播放

#### Scenario: 打断即时排空
- **WHEN** 用户打断,大脑调用 `clearBuffer()`
- **THEN** 终端立即排空已缓冲未播音频(本地动作,不等大脑往返)且后续旧 generation 帧被丢弃

### Requirement: 连接生命周期与协议版本协商

系统 SHALL 在建连后协商 `protocolVersion`(大脑兼容当前与前一版本,过旧终端明确拒绝),并维持应用层心跳与指数退避重连(1s→30s)及保活窗口。

#### Scenario: 协议版本不兼容被拒绝
- **WHEN** 终端握手声明的 `protocolVersion` 早于大脑支持的最低版本
- **THEN** 大脑以清晰错误码 + 中文原因拒绝连接,不进入会话

#### Scenario: 断线指数重连
- **WHEN** 终端与大脑连接中断
- **THEN** 终端按 1s→2s→…→30s 退避重连,大脑在保活窗口内保留 session 状态

### Requirement: 优雅降级与可测性

系统 SHALL 在任一连接阶段失败时降级而非崩溃;WebSocket 连接 SHALL 经可注入工厂构造,使单元测试不依赖真实网络。

#### Scenario: 握手/网络失败不崩
- **WHEN** WS 连接建立失败或握手报错
- **THEN** 系统抛出可被上层捕获的清晰错误并触发重连/提示,不进程崩溃、不静默卡死

#### Scenario: 注入 mock WS 的确定性测试
- **WHEN** 测试注入 FakeWs 工厂并同步驱动 open/message/close
- **THEN** 可断言上下行帧、generation 丢弃、握手与重连逻辑,且不发起真实网络请求
