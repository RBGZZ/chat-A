## ADDED Requirements

### Requirement: DashScope qwen-tts-realtime 流式 TTS Provider

系统 SHALL 通过 TTS Provider 注册表把判别联合 `kind:'qwen-tts'` 映射到 `QwenTtsRealtime` 实现,经 DashScope WebSocket(OpenAI-Realtime 风格协议)做**流式语音合成**(承 §4 流式优先、§4.3 可换性)。加它 MUST 只需在注册表登记工厂,`createTts` 核心 MUST 零改动。

`QwenTtsRealtime` MUST 实现 `TtsProvider`:`synthesize(text, opts?, signal?)` 返回 `AsyncIterable<PcmChunk>`,产出 **24kHz mono Int16**(对齐 `TTS_SAMPLE_RATE_HZ`,默认 `response_format=PCM_24000HZ_MONO_16BIT`),且 MUST **边收边产**(收到首个 `response.audio.delta` 即 yield,不等整段),以求低首音延迟。`id` MUST 仅供 trace/日志,业务不得据此分支。

能力声明 MUST 含 `languages`(多语种 `['*']`)、`voiceId`(内置音色)、`sampleRate:24000`、`streaming:true`、`voiceCloning:false`。`synthesize` MUST 先过能力门 fail-fast:语种不在 `languages` 内(`assertTtsLanguage`)、或请求复刻(带 `refAudio`)而 `voiceCloning=false`(`assertTtsCloning`)即抛(承 §4.1/§4.3)。

WebSocket 连接 MUST 经**可注入工厂端口**建立(镜像 kokoro 的 R1 注入接缝),以保证单测**不触真网络**;缺省工厂在真实运行时懒加载 WebSocket 实现建连。鉴权 MUST 用 `Authorization: Bearer <key>` 请求头,且**任何日志/错误信息 MUST NOT 含 key 明文**。默认 base URL/model MUST 为可配置项(无 magic number、不写死日期快照),可经配置/环境变量覆盖(承 §3.2)。

#### Scenario: 流式产出 PcmChunk

- **WHEN** 注入的 WebSocket 依次回放 `session.created`→`response.audio.delta`(base64 PCM)×N→`response.done`,调用 `synthesize(text)`
- **THEN** 迭代器逐个产出对应 `PcmChunk`(`sampleRate===24000`、`channels===1`、`samples` 为 base64 解码后的 Int16 小端样本),首帧到达即产出、不等整段

#### Scenario: AbortSignal 中途取消真停

- **WHEN** `synthesize(text, opts, signal)` 进行中(已建连、尚有未收音频),`signal` 被 `abort()`
- **THEN** 迭代器停止继续产出,且实现向服务端发 `input_text_buffer.clear` 并关闭 WebSocket(不再后台合成/烧远端额度)

#### Scenario: 连接/鉴权/协议错误优雅降级

- **WHEN** WebSocket 触发 `error`/异常 `close`,或服务端回 `error` 事件
- **THEN** `synthesize` 抛出带上下文的清晰中文错误(含 provider id 与错误片段,**不含 key 明文**),由上层按既有降级策略处理,而非静默吞或崩溃

#### Scenario: 能力门拒绝复刻与不支持语种

- **WHEN** 调用 `synthesize` 时带 `refAudio`(请求复刻),或 `opts.language` 不在能力 `languages` 内
- **THEN** 分别因 `voiceCloning=false` / 语种不支持而 fail-fast 抛错,不建立连接

#### Scenario: 缺 apiKey 构造即报错

- **WHEN** 以缺失/空 `apiKey` 构造 `QwenTtsRealtime`(或经工厂)
- **THEN** 构造即抛清晰错误,提示设置 `CHAT_A_DASHSCOPE_API_KEY`(或 `CHAT_A_TTS_API_KEY`),不返回不可用实例

#### Scenario: qwen-tts 已登记于注册表且可配置解析

- **WHEN** 读取已注册 TTS kinds,并以 `CHAT_A_TTS_KIND=qwen-tts` + 相关 env 调 `loadTtsConfig`
- **THEN** kinds 列表含 `'qwen-tts'`;`loadTtsConfig` 返回 `kind:'qwen-tts'` 配置(model/voice/endpoint 等正确,apiKey 可回落 `CHAT_A_DASHSCOPE_API_KEY`),加它未改动 `createTts` 核心解析逻辑
