## Why

朗读音频比文字慢几秒(R7):文字逐 token 流式即时显示,但音频在**整段回复生成完之后**才启动(speakReply 在 convo.send 返回后跑),且 CosyVoice **整段一次合成**(等整段文本到齐才出首音)。当初改"整段一次合成"是为防复刻音色逐句漂移——但 **2026-06-25 真机验证证实:CosyVoice 同一 run-task 内多次 `continue-task` 逐句喂 = 流式 + 音色一致不漂移**(探活 B 不飘 ≈ A 整段;C 每句独立 task 才漂)。即"逐句流式"与"音色一致"能兼得,**当初把两者绑死是过度收缩**。

承新确立的 canonical §3.2「流式优先·快反应·低音频延迟」原则:朗读应**首句即合成、绝不等整段**。

## What Changes

- **CosyVoiceTts 同 session 流式合成 API**:新增"开 task → `pushText(chunk)`×N → `finish()` → 产 PcmChunk 流"接口(一个 run-task 内多次 continue-task)。既有一次性 `synthesize(text)` 不变。这是真机验证过的"流式 + 不漂移"能力。
- **desktop 朗读路改流式**:回复 token 流经 SentenceSplitter 句切 → **首句到齐即喂同一 TTS session、边合边出声**,不等整段;同 session 喂 → 音色一致。`needsTranslation`(显示≠合成语种)时:翻译后逐句喂(仍同 session 流式,但起步受翻译延迟限制——根治该情况走 parked 的 bilingual-native-output)。
- **门控 + 降级**:`CHAT_A_TTS_STREAM_READOUT`(默认 off → 沿用现整段合成,逐字回归);流式失败 → 降级整段合成(§3.2),不崩。
- **修语音模式同源漂移(同 API)**:VoiceLoop `#speak` 现每句独立 `synthesize`(多 session → 复刻音色会漂),复用本流式 API 改"回合内同 session 逐句喂"——**作为后续切片**(本次先做 desktop 朗读路,API 共用)。

## Capabilities

### New Capabilities
- `streaming-tts-readout`: 朗读路按句流式喂同一 TTS session、首句即出声、音色一致的端到端能力(门控、默认 off、失败降级整段)。

### Modified Capabilities
- `tts-engine`: `CosyVoiceTts` 新增同 session 流式喂文本接口(开 task→pushText×N→finish),供逐句流式且不漂移。
- `desktop-electron-frontend`: 朗读路在流式模式下句切 + 同 session 逐句喂(首句即合成),取代整段一次合成;失败降级。

## Impact

- **改动代码**:`packages/providers/src/cosyvoice-tts.ts`(流式接口 + 单测,复用现有注入 wsFactory)、`packages/desktop/src/main.ts`/`ipc-contract.ts`(朗读路句切流式喂 + 门控 + 降级)。
- **canonical 接缝**:§3.2(流式优先/低音频延迟,本 change 正是其落地)、§4.1(TTS)、§3.1(降级/行为即配置/可测)。不改记忆/人格/帧管线核心。
- **延迟**:首音从"等整段合成"降到"首句合成"(默认/同语种场景显著);翻译场景仍受翻译延迟,根治走 bilingual。
- **音色**:同 session 喂 = 不漂移(真机已验),与整段一致。
- **非目标**:不做 dual-output / 砍翻译(那是 parked bilingual,本 change 提供其 D7 复用的流式 API);VoiceLoop 语音模式改造作为后续切片(共用本 API);filler/quick-final 留后续(canonical §3.2 子条款,另立)。
