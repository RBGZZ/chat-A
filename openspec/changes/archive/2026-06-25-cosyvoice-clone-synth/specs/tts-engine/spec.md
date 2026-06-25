## ADDED Requirements

### Requirement: CosyVoice run-task WebSocket 流式合成 provider

系统 SHALL 提供实现 `TtsProvider` 的 CosyVoice 合成 provider,经 DashScope `run-task`/`continue-task`/`finish-task` WebSocket 协议(端点 `/api-ws/v1/inference`、Bearer 握手鉴权)流式合成。`run-task` SHALL 携带固定 `header.streaming:"duplex"`、全程同一 `task_id`、`payload:{task_group:"audio", task:"tts", function:"SpeechSynthesizer", model, parameters, input:{}}`,其中 `parameters.voice`=复刻 voiceId、`parameters.format`/`sample_rate` 可配(默认 `pcm`/24000)。文本经 `continue-task` 的 `input.text` 发送,`finish-task` 收尾。端点、协议字段、默认参数 SHALL 隔离在可改函数/常量以便真机校准。该 provider 与现有 qwen-tts 及其它 provider 并存,缺省不配置时其它路径逐字不变。

#### Scenario: 流式逐帧产出音频
- **WHEN** 调用 synthesize 且服务端经二进制帧回送 PCM 音频
- **THEN** provider 把二进制裸 PCM 帧拼接并逐块产出 `PcmChunk`(s16le、跨帧半样本进位)

#### Scenario: 合成模型与复刻 target_model 一致
- **WHEN** 使用 CosyVoice 复刻音色合成
- **THEN** provider 的合成 `model` 与该音色复刻时的 `target_model` 逐字一致(由装配层保证),否则合成失败按错误路径处理

#### Scenario: task-failed 错误透出
- **WHEN** 服务端返回 `task-failed`
- **THEN** provider 抛出含 `error_code`/`error_message` 的清晰中文错误(**不含 key**),不丢失真因

#### Scenario: 打断真取消
- **WHEN** synthesize 收到 AbortSignal 取消
- **THEN** provider 停止产出、关闭连接,迭代干净结束

#### Scenario: 注入 wsFactory 单测不触网
- **WHEN** 调用方注入 mock WS 工厂
- **THEN** 合成全程不建立真实 WebSocket 连接,事件由 mock 驱动

#### Scenario: 缺 key fail-fast
- **WHEN** 构造 provider 时缺少 DashScope API key
- **THEN** 构造即抛清晰中文错误(**绝不打印 key**)
