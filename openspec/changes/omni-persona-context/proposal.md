# 修复 omni audio-in 直路丢失人设/记忆/语气

## Why

omni audio-in 直路(path B,§4 双路径)目前在 `VoiceLoop.#startThinkingOmni` 里调
`omni.respondToAudio(toChunks(), {}, signal)`——**空 opts**,且整条 omni 直路**绕开了 prompt 组装**
(persona / memory recall / tone / 立场 / 风格纪律都在 STT 路 `Conversation.send` → `composeSystem`
里组装,omni 路从不经过)。真网络实测:omni 模式下小雪回复退化成通用「AI 助手」腔、无人设、无记忆、
无语气——与北极星「长期伴侣而非谈话助手」直接相悖,是 path B 的一个**真 bug**(非锦上添花)。

`QwenOmniLlm.respondToAudio(audio, opts?, signal?)` 的 `opts.instructions` 支持把系统提示映射到
omni session 的 `session.update.instructions`,但 VoiceLoop 从未填它。本变更补上这一接缝,让 omni
模式下的小雪和 STT 路一样有灵魂(persona/记忆/语气)。

## What Changes

- **新增可选注入接缝** `VoiceLoopDeps.composeOmniInstructions?: () => string | Promise<string>`:
  omni 回合在调 `respondToAudio` 前先 `await` 它取得组装好的系统提示,以 `{ instructions }` 传入;
  **未注入 / 抛错 / 超时 / 空** → 退回现状(空 opts,与本变更前逐字一致),绝不崩、不阻塞。
- **`OmniAudioPort` 的 opts 由 `Record<string, never>` 放宽为 `OmniAudioOpts { instructions? }`**
  (与 `QwenOmniLlm.OmniAudioOptions` 兼容;纯加法,既有空 opts 调用仍合法)。
- **`Conversation` 导出只读复用接缝** `composeOmniInstructions(): Promise<string>`:复用既有
  `composeSystem`(persona 骨架 + 记忆召回 + tone + 立场 + 风格纪律),返回组装的 `system` 字符串;
  无本轮 userText(omni 是「音频进、模型直接听」,用户这轮说了什么由模型自己听),故以空 query 组装
  (记忆走既有快路径/不阻塞);任何失败 → 退回人设骨架最小提示(persona 身份),绝不空、不抛。
- **装配层 `cli-voice` 注入**:`startVoiceMode` 透传一个可选 `composeOmniInstructions` 到 `loopDeps`;
  `cli.ts` 在语音模式以 `() => convo.composeOmniInstructions()` 注入(与 STT 路同源 persona/memory/tone)。

## Non-goals

- **不改 STT 路径**:STT 路(缺省)的状态机、BusEvent、prompt 组装、下行 tts:chunk **逐字不变**(回归硬线)。
- **不把本轮 transcript 塞进 instructions**:omni 模型自己听用户音频;instructions 只给人设/记忆/语气背景。
- **不碰** `packages/providers` / `packages/persona` / `packages/memory` 内部(只调既有 API)。
- 不实装真机/真网络验证(omni 模式人设是否真生效需真连 DashScope,留手测);本变更只补接缝 + 不触网单测。

## 延迟预算影响(§3.2)

- STT 路:**零影响**(不经新接缝)。
- omni 路:`composeOmniInstructions` 在**开 WS 连接 / 首音前**组装一次(与 STT 路首字前组装 system 同
  量级);记忆召回沿用既有同步快路径(无语义嵌入时不触网),不引入新的首音前阻塞外部调用。
  失败/超时 → 立即用 persona 骨架最小提示兜底,绝不卡住 omni 首音(§5.5 非阻塞召回硬约束)。
