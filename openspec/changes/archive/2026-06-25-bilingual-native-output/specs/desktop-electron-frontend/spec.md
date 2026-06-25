## ADDED Requirements

### Requirement: desktop 双语模式流式拆分与原生朗读

双语模式生效时,desktop SHALL 在回合流式过程中按分隔标记拆分:标记前内容作显示正文逐 token 推 `chat:token`;标记后内容缓冲为 spokenText(不进显示),回合结束后作为合成文本喂 TTS,**取代**该回合的 `translateForSpeech` 第二次调用。未生效时朗读链路逐字现状。

#### Scenario: 拆分后显示与朗读各取所需
- **WHEN** 双语模式回合产出"中文正文 ⟦标记⟧ 日语口语版"
- **THEN** 中文正文进气泡、日语口语版喂 TTS;本回合不调用翻译通道

#### Scenario: 缺口语版回落翻译通道
- **WHEN** 双语模式回合解析不到标记/口语版
- **THEN** desktop 回落 `translateForSpeech`(或显示文本直接合成),显示正文已照常呈现、朗读不中断

#### Scenario: 关闭开关沿用现状
- **WHEN** `CHAT_A_TTS_DUAL_OUTPUT` 未启用
- **THEN** desktop 朗读仍按 `resolveSpokenPlan` 走直接合成或翻译通道,行为逐字不变
