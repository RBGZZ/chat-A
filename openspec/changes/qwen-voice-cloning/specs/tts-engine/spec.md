## ADDED Requirements

### Requirement: qwen-tts-realtime 支持复刻音色合成

`QwenTtsRealtime` SHALL 在内置音色之外支持**复刻音色合成**:当配置启用复刻(`voiceCloning=true`,对应配置 vc 实时模型如 `qwen3-tts-vc-realtime`)时,`capabilities.voiceCloning` MUST 为 `true`,且 `TtsOptions.voiceId` 为复刻得到的 voice id 时 MUST 作为 WebSocket `session.update` 的 `voice` 字段透传给服务端。该能力位 MUST 由配置驱动且**缺省为 false**;默认不启用时既有内置音色合成路径(请求形态与产出)MUST **逐字不变**。

#### Scenario: 配 vc 模型时声明复刻能力
- **WHEN** 以 `voiceCloning: true` 构造 `QwenTtsRealtime`
- **THEN** 其 `capabilities.voiceCloning` 为 `true`

#### Scenario: 复刻 voiceId 作为 voice 透传
- **WHEN** `voiceCloning=true` 且 `synthesize(text, { voiceId: '<复刻voiceId>' })`
- **THEN** 发往服务端的 `session.update` 的 `voice` 字段为该复刻 voiceId

#### Scenario: 默认不启用复刻时行为不变
- **WHEN** 未设置 `voiceCloning`(缺省)构造 `QwenTtsRealtime`
- **THEN** `capabilities.voiceCloning` 为 `false`,内置音色合成的请求与产出与现状逐字一致

#### Scenario: 配置经 env 启用复刻并选 vc 模型
- **WHEN** 设置 `CHAT_A_TTS_KIND=qwen-tts`、`CHAT_A_TTS_VOICE_CLONING=1`、`CHAT_A_TTS_MODEL=qwen3-tts-vc-realtime`
- **THEN** `loadTtsConfig` 产出的 `QwenTtsRealtimeConfig` 携带 `voiceCloning: true` 且 `createTts` 装配出 `capabilities.voiceCloning=true` 的 provider
