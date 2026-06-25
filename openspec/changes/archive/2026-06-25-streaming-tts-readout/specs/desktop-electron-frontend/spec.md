## ADDED Requirements

### Requirement: desktop 朗读路句切 + 同会话逐句流式喂

启用 `CHAT_A_TTS_STREAM_READOUT` 时,desktop 朗读 SHALL:把待朗读文本(spokenText,同语种=回复本身;异语种=翻译后)经 SentenceSplitter 句切,逐句喂入 `CosyVoiceTts` 的**同一流式会话**,边合边经 `IPC.ttsAudio` 推渲染层播放;首句即出声、不等整段合成。未启用时沿用整段一次合成(逐字回归)。打断(新消息/停止)SHALL 干净停止流式会话。

#### Scenario: 流式朗读首句即出声
- **WHEN** 流式朗读启用,spokenText 第一句就绪
- **THEN** 该句即喂同会话合成、推音频块,后续句接上

#### Scenario: 打断停止流式会话
- **WHEN** 朗读途中用户发新消息/点停
- **THEN** abort 流式会话 + 发 ttsAudioStop,渲染层立即停播清队列

#### Scenario: 翻译场景仍同会话流式
- **WHEN** 显示≠合成语种(needsTranslation),翻译得整段 spokenText
- **THEN** 仍句切 + 同会话逐句喂(流式合成);翻译延迟仍在(根治走 dual-output,非本能力)

#### Scenario: 未启用沿用整段
- **WHEN** `CHAT_A_TTS_STREAM_READOUT` 未启用
- **THEN** 朗读走整段一次合成,逐字现状
