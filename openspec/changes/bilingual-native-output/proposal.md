## Why

desktop 现在"显示语种≠合成语种"时(如显示中文、朗读日语),走**翻译通道**:主回复生成后**再发一次 LLM 调用** `translateForSpeech` 把显示文本逐句译成合成语种(`ipc-contract.ts:627`)。两个问题:

- **是"翻译"不是"原生"**:日语口语是把中文译过去,易生硬、漂意,丢小雪的语气。
- **多一次 LLM 往返**:朗读要等翻译整段完才出声,首音更慢、多花一次调用。

更好的做法:**让主 LLM 一次同时产出两版——显示语种正文 + 合成语种原生口语版**(各自母语原生、同源同人设),省掉翻译这趟,音频更自然、更快。项目"显示/合成解耦"(displayText≠spokenText)本就是一等概念,天然容得下双输出。

## What Changes

- **新增"双语原生输出"模式**:显示≠合成语种且开关开启时,系统提示要求 LLM 在一次回复里产出**显示语种正文** + **明确分隔的合成语种原生口语版**;desktop 流式拆分:分隔标记前的流→显示气泡(chat:token),标记后的→缓冲为 spokenText→TTS。
- **新增 dual-output 提示词贡献者**(prompt-assembly):仅在双语模式生效时注入"按约定格式给两版、口语版用纯口语(不带括号舞台提示)"的指令;默认/同语种**零注入**(逐字现状)。
- **desktop 朗读路改造**:双语模式下用 LLM 直出的原生 spokenText 喂 TTS,**取代** translateForSpeech 的第二次调用;**优雅降级**——模型没按格式/口语版空/解析失败 → 回落现有 translateForSpeech 翻译通道(再不行用 displayText)。**翻译通道保留为 fallback,不删**。
- **全程流式(含音频)**:口语版**逐句流式喂 TTS、音频边生成边出声**(解 R7 音频滞后数秒)。**支点**:扩 `CosyVoiceTts` 加流式喂文本 API,利用 CosyVoice run-task 单 task 内多次 `continue-task` 增量送文本 → 一个合成 task 内逐句喂 → 首句即出首音、全程单 voice 上下文**无逐句音色漂移**(绕开当初"整段一次合成"的原因)。
- **门控 + 零回归**:`CHAT_A_TTS_DUAL_OUTPUT`(默认 off)。off 或同语种时,显示流式与朗读链路逐字现状(仍走 translateForSpeech 或直接整段合成)。

## Capabilities

### New Capabilities
- `bilingual-native-output`: 单次 LLM 调用产出显示语种正文 + 合成语种原生口语版,流式拆分喂显示/TTS,失败优雅降级回翻译通道的端到端能力(门控、默认 off)。

### Modified Capabilities
- `prompt-assembly`: 新增门控的 dual-output 指令贡献者(仅双语模式注入;约定格式 + 口语版纯口语)。
- `desktop-electron-frontend`: 朗读路在双语模式下流式拆分 display/spoken、口语版逐句流式喂 TTS、用原生 spokenText 替代翻译调用、保留 translateForSpeech 作 fallback。
- `tts-engine`: `CosyVoiceTts` 新增流式喂文本接口(开 task → pushText×N → finish,单 task 多次 continue-task),供逐句流式合成且不引入音色漂移。

## Impact

- **改动代码**:`packages/cognition/src/prompt/`(新 dual-output contributor,门控)、`packages/desktop/src/`(send/onToken 流式拆分 + speakReply 用原生 spokenText + 降级)、`ipc-contract.ts`(spoken 来源分支;translateForSpeech 留作 fallback)。
- **canonical 接缝**:§4.1(显示/合成语种解耦)、§3.2(流式优先——拆分不得拖垮显示流式)、§3.1(优雅降级、行为即配置)。不改记忆/人格/帧管线核心。
- **延迟/成本**:省掉翻译第二趟 LLM 往返(首音更快);单次调用输出变长(两版),总 token 与"生成+翻译"相当。
- **流式风险(设计重点)**:显示正文必须照常逐 token 流到 UI;分隔标记后的口语版不进 UI——需 onToken 级的标记检测/截流(复用 canonical:148"括号配平流式检测器"同类技术)。
- **与括号舞台提示治理叠加**:口语版要求纯口语(本就不该带括号),两件事在 spoken 文本上汇合;dual-output 的 spoken 直接干净,省去再剥。
- **非目标**:语音模式(voice-loop/omni)双语原生作为后续扩展点(本次只做 desktop 文字朗读路);不删翻译通道(留 fallback);不强制结构化 JSON(避免破坏流式,用轻量分隔标记)。
