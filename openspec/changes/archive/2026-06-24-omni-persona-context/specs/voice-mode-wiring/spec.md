# voice-mode-wiring Specification (delta)

## ADDED Requirements

### Requirement: omni 直路携带组装好的系统提示(persona/记忆/语气)

`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**注入
`composeOmniInstructions?: () => string | Promise<string>`,用于为 omni audio-in 直路(path B)
提供组装好的系统提示(persona 身份 + 记忆 + 语气/立场/风格)。当注入了该接缝**且**走 omni 直路时,
`VoiceLoop` MUST 在调用 `omni.respondToAudio(...)` **之前** `await` 该回调取得 instructions,并以
`{ instructions }`(`OmniAudioOpts`)传入 `respondToAudio` 的 opts 参数;`OmniAudioPort` 的 opts 类型
MUST 放宽以容纳可选 `instructions` 字段(与 `QwenOmniLlm.OmniAudioOptions` 兼容,纯加法)。

该接缝为**纯加法**:未注入(`composeOmniInstructions===undefined`)时,omni 直路 MUST 以空 opts 调用
`respondToAudio`,行为与本变更前**逐字一致**。本接缝 MUST NOT 影响 STT 路径(STT 路绝不经过它)。
instructions MUST NOT 包含本轮用户 transcript(omni 模型直接听原始音频,用户这轮说了什么由模型自己听;
instructions 只承载人设/记忆/语气背景)。

#### Scenario: 注入 composeOmniInstructions 时 omni 回合携带 instructions

- **WHEN** 注入吐 `transcript`/`text`/`end` 的 fake omni 端口 + 一个返回固定系统提示的
  `composeOmniInstructions`、语音路径为 omni,驱动一个回合
- **THEN** `omni.respondToAudio` 收到的 opts.instructions 等于该回调返回的系统提示;回合正常产出
  transcript 写记忆 + text→tts:chunk + end→回 listening

#### Scenario: 未注入 composeOmniInstructions 时 omni 回合传空 opts(逐字不变)

- **WHEN** 不注入 `composeOmniInstructions`、语音路径为 omni,驱动一个回合
- **THEN** `omni.respondToAudio` 以空 opts(不含 instructions)被调用,行为与本变更前一致

### Requirement: composeOmniInstructions 失败/超时优雅降级(§3.2)

`composeOmniInstructions` 接缝 MUST 优雅降级,绝不使 omni 回合崩溃、绝不阻塞 omni 首音(§5.5):
当注入的回调**抛错、超时、或返回空串**时,`VoiceLoop` MUST 退回以空 opts 调用 `respondToAudio`
(等价未注入),记日志,omni 回合 MUST 仍能正常推进并在结束/失败时干净回 listening。

#### Scenario: composeOmniInstructions 抛错时退回空 opts 不崩

- **WHEN** 注入的 `composeOmniInstructions` 抛错、语音路径为 omni,驱动一个回合
- **THEN** `VoiceLoop` 捕获错误、以空 opts 调用 `respondToAudio`、回合正常完成回 listening,不崩

### Requirement: Conversation 暴露 omni 系统提示组装(复用既有 prompt 组装)

`Conversation` SHALL 暴露只读方法 `composeOmniInstructions(): Promise<string>`,**复用**与
`Conversation.send` 同一套 prompt 组装(persona 骨架 + 记忆召回 + tone + 立场 + 风格纪律,
即既有 `composeSystem`),返回组装的 `system` 字符串(供 omni 直路当 instructions)。组装时
MUST 以空 userText(omni 无本轮文本)进行,记忆召回沿用既有快路径(不引入 omni 首音前新的网络阻塞,
§5.5)。内部任一步骤失败时,该方法 MUST 兜底返回 persona 骨架(身份最小提示),绝不返回空、绝不抛。

#### Scenario: 返回含人设骨架的系统提示

- **WHEN** 调用 `conversation.composeOmniInstructions()`
- **THEN** 返回的字符串非空且包含 persona 骨架(身份),复用与 `send` 同源的 persona/记忆/语气组装

#### Scenario: 内部组装失败兜底返回骨架

- **WHEN** 内部 `composeSystem` / 召回 / tone 抛错
- **THEN** 该方法返回 persona 骨架(非空),不抛、不返回空

### Requirement: 装配层为 omni 路注入 composeOmniInstructions

`cli --voice` 装配层 SHALL 在语音模式下把 `composeOmniInstructions` 注入 `VoiceLoop`:
`VoiceModeDeps` MUST 接受一个**可选** `composeOmniInstructions?`,`startVoiceMode` MUST 仅在提供时
透传进 `loopDeps`;`cli.ts` MUST 以 `() => convo.composeOmniInstructions()`(与文字链路同一 Conversation)
注入,使 omni 路与 STT 路同源 persona/记忆/语气。未提供时(或非 omni 路)MUST 不影响装配与现有行为。

#### Scenario: 语音模式注入与 Conversation 同源的 composeOmniInstructions

- **WHEN** `cli.ts` 启动语音模式
- **THEN** 透传给 `startVoiceMode` 的 `composeOmniInstructions` 调用的是 `convo.composeOmniInstructions`
  (与文字链路同一 Conversation 实例的 persona/记忆/语气组装)
