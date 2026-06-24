## Why

现状语音链路是 VAD→EOU→**STT**(把语音转成文字)→`send(text)`(LLM)→分句→TTS。
STT 把「**怎么说的**」(语气/韵律/情绪)丢掉了,只留「**说了什么**」——违背 canonical
§7 行为需求 5「从语音读情绪 prosody」(听出疲惫/低落,而非只读文本)、§4「双路径:优先
多模态 audio-in Provider,失败/超预算降级到 STT+LLM」。

provider 侧的 audio-in 直路(path B)已就绪:`packages/providers/src/qwen-omni-llm.ts` 的
`QwenOmniLlm.respondToAudio(audio, opts?, signal?): AsyncIterable<OmniEvent>` 吃 PCM 块流,
让模型**直接「听」原始音频**,yield `transcript`(用户话语)/ `text`(回复增量)/ `end`。
它**不在 LLM registry**(纯音频面,DashScope realtime 不接纯文本 item)。缺的只是把这条
直路**可选地**接进 VoiceLoop——这正是本 change 要做的(对应那个 provider change 的
`design.md §3.3` 留的接缝)。

**硬约束**:默认仍走现有 STT→LLM 路径,**行为逐字不变**(既有 voice-loop 测试全绿);
omni 直路是**可选**(配置开),不可用/失败时**优雅降级回 STT 路径**(canonical §3.2)。

## What Changes

- **VoiceLoop 增可选 omni audio-in 直路分支**:在 VoiceLoopDeps 加**可选** omni 端口
  (`respondToAudio(audio, opts?, signal?) => AsyncIterable<OmniEvent>` 形态);**未注入 =
  纯走现有 STT 路径(零改)**。注入后,endpointing 攒的音频帧**不喂 STT**,而喂
  `omni.respondToAudio(audioChunks, {}, signal)`,消费事件:
  - `transcript` → 当作「这轮用户说了啥」(等价 STT 文本),写记忆(供记忆/召回);
    并 emit `stt:final`(携真转写文本)推进 endpointing→thinking。
  - `text` → 当作回复增量喂**现有 SentenceSplitter 分句 → TTS**(复用既有 `#speak`)。
  - `end` → 收尾(复用既有 `#finishTurn`)。
- **复用既有打断/generation/半句写回核心**:omni 回合同样建本回合 `AbortController`,把
  `signal` 透传给 `respondToAudio`;barge-in / stop 时 `abort()` 真停底层 WS 流;
  `#gen` 自检作废、半句写回(`#replyAccum + [被用户打断]`)与现状一致,**不重写打断核心**。
- **优雅降级(§3.2)**:omni 端口缺失 → 走 STT 路径;`respondToAudio` 抛错 / 连接失败 /
  WS 意外关闭 → 干净结束本回合回 listening(不崩),并记日志(后续可由网关层做「自动切
  STT 重试」,本 change 先保证不崩 + 默认路径不受影响)。
- **状态机最小微调**:omni 直路**无独立 STT step**(转写来自 omni 事件)。复用既有
  `endpointing --stt:final--> thinking --tts:first_audio--> speaking --turn:end--> listening`
  迁移,不新增状态/事件——`transcript` 事件触发 `stt:final` 迁移即可承载。
- **装配/配置**:cli-voice / voice-runner 增 `CHAT_A_VOICE_PATH=stt|omni`(**缺省 `stt`**)。
  omni 档构造 `QwenOmniLlm`(它不在 LLM registry,加一个小工厂 `createOmniAudioPort`,
  key 读 `CHAT_A_DASHSCOPE_API_KEY`,model/baseURL 走配置/默认);构造/key 缺失失败 →
  打印明确中文提示并**回落 STT 路径**(沿用真设备回落范式)。

非破坏性:VoiceLoopDeps 公共形状仅**追加**一个可选字段(`omni?`);未注入时 VoiceLoop
行为与产出逐字不变。

## Capabilities

### New Capabilities
<!-- 无新增独立 capability;复用 voice-mode-wiring(装配/配置接缝)。 -->

### Modified Capabilities
- `voice-mode-wiring`: 新增「按 `CHAT_A_VOICE_PATH` 选 STT/omni 语音路径」装配开关与
  「VoiceLoop 可选 omni audio-in 直路 + 降级回 STT」运行时行为。缺省 `stt` 时装配与
  VoiceLoop 行为**逐字不变**;omni 档让小雪直接「听」原始音频(承 §7#5 prosody)。

## Impact

- **影响 canonical 章节**:§4(双路径:优先多模态 audio-in,失败降级 STT)、§7 行为需求 5
  (从语音读情绪 prosody)、§3.2(优雅降级 / 真打断)。与权威设计一致,无冲突。
- **代码**:
  - `packages/runtime/src/voice-loop.ts`(omni 直路分支 + 降级;复用打断/generation/分句/写回)。
  - `packages/runtime/src/voice-turn-state.ts`(注释说明 omni 路径复用现有迁移;**不新增态**)。
  - `packages/client/src/{cli-voice.ts,audio/voice-runner.ts}`(`CHAT_A_VOICE_PATH` 配置 +
    `createOmniAudioPort` 小工厂 + 回落 STT)。
  - providers 的 `qwen-omni` 只**调用/构造**,不改其内部。
- **测试**:`packages/runtime/test/voice-loop-omni.test.ts` 新增 omni 直路用例(注入
  **fake omni** 吐 `transcript+text+end` 的 AsyncIterable + Stub VAD/EOU,**不触网**):
  覆盖①直路产出 transcript 写记忆 + text→TTS、②打断(omni 回合 signal aborted + 半句写回)、
  ③降级回 STT(omni 抛错)、④默认 STT 路径回归绿(既有 voice-loop.test.ts 不动)。
- **不涉及**:memory / persona / voice-detect / gateway / autonomy 内部;不动 LLM registry
  的 createLlm 核心。
- **真机/真网络不验证**(无 key / headless):真 DashScope omni-realtime WS 端到端、真麦克风
  连续对话留**真机待验**。
