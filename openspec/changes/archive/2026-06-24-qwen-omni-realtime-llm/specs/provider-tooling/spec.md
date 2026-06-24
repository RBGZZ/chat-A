## ADDED Requirements

### Requirement: Qwen Omni Realtime(WebSocket 多模态)Provider 注册与 audio-in→文本流

系统 SHALL 通过 LLM Provider 注册表把开放字符串 `provider='qwen-omni'` 映射到基于 DashScope **WebSocket 实时多模态**端点(OpenAI-Realtime 风格协议)的 `QwenOmniLlm`;加它 MUST 只需在注册表登记工厂,`createLlm` 核心与系统其余部分 MUST 零改动(承 §3.1 接缝)。默认 WS 端点 MUST 为具名常量 `QWEN_DASHSCOPE_REALTIME_URL`(`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`,无 magic number),且 MUST 可经 `LlmConfig.baseURL` 覆盖(承 §3.2 行为即配置);model id MUST 由配置传入(不写死快照名)。该 Provider 在 `apiKey` 缺失或为空时 MUST 抛清晰错误(指向应设的环境变量),而非静默构造不可用实例。

该 Provider MUST 实现 `LlmProvider` 的文本兼容面(`stream`/`complete`),把文本 prompt 经 WS(`modalities:["text"]`)送出并聚合 `response.text.delta` 回吐字符串流,使其可作为现有「STT→文本LLM」路径的**可选替代**装入 registry 而**不破坏**现有路径。该 Provider MUST 另提供真多模态面 `respondToAudio`(吃 PCM 块流 → 经 `input_audio_buffer.append` 送出 → 产出 transcript/text/end 判别联合事件),为后续 runtime 接入 audio-in 直路留接缝。该 Provider MUST 支持 `AbortSignal` 真取消(abort 时关闭 WS、停止产出,承 §3.2 真打断),MUST 在鉴权/连接/能力缺失时 fail-fast 抛清晰错误(供上层优雅降级回传统路径),并 MUST 支持 WS 连接注入(工厂模式)以做不依赖真实网络的确定性测试。本要求 MUST 不改动 VoiceLoop / TTS;audio-in 直路接入 VoiceLoop 不在本要求范围。

#### Scenario: createLlm 解析 qwen-omni 为 WS 多模态 Provider

- **WHEN** 以 `{ provider:'qwen-omni', model:'qwen3.5-omni-flash-realtime', apiKey:'<key>' }` 调用 `createLlm`
- **THEN** 返回 `QwenOmniLlm` 实例,其 `id` 为 `'qwen-omni'`,默认 WS 端点为 `QWEN_DASHSCOPE_REALTIME_URL`

#### Scenario: qwen-omni 已登记于注册表

- **WHEN** 读取已注册的 LLM Provider 列表
- **THEN** 列表包含 `'qwen-omni'`,加它未改动 `createLlm` 核心解析逻辑,且与纯文本 `'qwen'` 区分

#### Scenario: 缺 apiKey 抛清晰错误

- **WHEN** 以 `{ provider:'qwen-omni', model }`(无 apiKey)调用 `createLlm`
- **THEN** 抛出明确错误,提示需要设置 API key(环境变量),不返回不可用实例

#### Scenario: 文本兼容面经 WS 流式回吐文本

- **WHEN** 以文本 `LlmRequest` 调用 `stream`,服务端经 WS 回若干 `response.text.delta` 后 `response.done`
- **THEN** `stream` 依序 yield 各 delta 文本,`response.done` 后结束并关闭 WS;请求中含 `session.update`(`modalities:["text"]`)与文本内容项

#### Scenario: 真多模态面 audio-in 产出 transcript 与回复文本

- **WHEN** 向 `respondToAudio` 喂 PCM 块流,服务端回 `conversation.item.input_audio_transcription.completed`(transcript)与 `response.text.delta`(回复)
- **THEN** Provider 把音频经 `input_audio_buffer.append`(base64)送出,并产出 `{type:'transcript'}`(用户话语)+ `{type:'text'}`(回复增量)+ `{type:'end'}`

#### Scenario: AbortSignal 中途真取消

- **WHEN** 流式产出进行中其 `signal` 被 abort
- **THEN** Provider 关闭 WS 并停止产出(生成器终止),不再 yield 后续事件

#### Scenario: 连接/鉴权失败优雅降级

- **WHEN** WS 收到 `error` 事件或发生非正常关闭
- **THEN** 当前调用抛出清晰错误(不打印鉴权字段),供上层 catch 后降级回传统 STT→文本LLM 路径

#### Scenario: WS 连接可注入以确定性测试

- **WHEN** 构造 `QwenOmniLlm` 时注入自定义 WS 工厂(mock)
- **THEN** Provider 用注入的连接收发事件,测试无需真实网络即可覆盖正常流式/打断/错误降级
