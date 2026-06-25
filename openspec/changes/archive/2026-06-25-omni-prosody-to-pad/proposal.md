## Why

chat-A 语音的 omni 多模态直路(path B,`CHAT_A_VOICE_PATH=omni`)目前**不把用户说话的语气情绪喂进 PAD 情感内核**:`#startThinkingOmni` 直接消费 `omni.respondToAudio` 的 `transcript`/`text`/`end`,既不产情绪信号、也不向情感内核透传。对比 STT 路已用 `#send` 第 4 参把 qwen-asr 的 7 类情绪标签经 `prosodyToPadPull` → `persona.advance({prosodyEmotion})` 并入 PAD。这违背 canonical §7 底线「带情绪的语音(prosody)永不漏听」——走 omni 时心情持久态不受用户语气驱动。本变更补齐这条断链(方案 A,设计依据 `docs/multimodal-voice-emotion-investigation-2026-06-25.md` §5 P1)。

## What Changes

- **omni instructions 注入情绪标签门控指令**:在 omni 直路系统提示组装(`Conversation.composeOmniInstructions`)末尾追加一段**仅 omni 路**生效的机读指令,要求模型在回复**末尾**附 `[user_emotion:<label>-<intensity>]`(label 取与 STT 一致的 7 类情绪集合 `surprised/neutral/happy/sad/disgusted/angry/fearful`,intensity 1–10)。STT 路与文字路**不经过此指令**,零影响。
- **VoiceLoop 剥标签 + 喂 PAD**:`#startThinkingOmni` 流式累积回复时,以一个纯函数从**回复尾部**解析 `[user_emotion:...]`,**剥掉它再进 TTS / 显示 / 记忆**(绝不念出标签、不入气泡/记忆,参考 `stripStageDirections` 的「不进 TTS」思路);解析出的情绪映射成 `SttEmotionLike` → 经新钩子喂 PAD。多标签取**最后一个**,畸形/无标签则零情绪。
- **新增可选注入钩子** `advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>`(VoiceLoop deps,纯加法、exactOptional 风格):缺省不注入 → omni 路逐字现状(零回归)。注入后,omni 回合解析出情绪时调用它把情绪推进 PAD。失败/抛错被捕获,不中断回合(§3.2 降级)。
- **装配层接线**:`Conversation` 新增 `advanceProsody(emotion)` 方法(调其**内部** persona 的 `advance('', { prosodyEmotion })`,复用现成 `prosodyToPadPull`,不新写映射),装配层(cli-voice / app)以 `(e) => convo.advanceProsody(e)` 注入,镜像现有 `composeOmniInstructions: () => convo.composeOmniInstructions()` 接线。

## Capabilities

### New Capabilities
<!-- 无新增 capability;复用既有 voice-mode-wiring 与 persona-emotion 的 PAD 通道。 -->

### Modified Capabilities
- `voice-mode-wiring`: omni audio-in 直路(path B)新增「把用户语气情绪经显式标签链路喂进 PAD」的要求——instructions 注入标签指令、VoiceLoop 剥标签+经可选 `advanceProsody` 钩子推进 PAD、缺省不注入/无标签/解析失败时零回归。

## Impact

- **canonical 章节/接缝**:落地 §7 底线「prosody 永不漏听」(omni 路);复用 §6 PAD 内核(`persona.advance` prosody-only 通道,经 §7#5 `prosodyToPadPull`)、§4 双路径接缝、§5.4 omni instructions 组装。仅触 omni 路,不改 STT/文字路。
- **代码**:`packages/runtime/src/voice-loop.ts`(`#startThinkingOmni` 区域 + deps `advanceProsody?`)、新增标签解析纯函数(runtime)、`packages/runtime/src/conversation.ts`(`composeOmniInstructions` 追加指令 + 新增 `advanceProsody` 方法)、`packages/client/src/cli-voice.ts` 与 `packages/client/src/assembly/app.ts`(接线钩子)。可能小动 `packages/desktop/src/main.ts`(若 desktop 也复用同套 omni 装配)。
- **延迟预算(§3.2)**:情绪喂 PAD 是旁路、非首字延迟热路径(钩子可 fire-and-forget,失败吞);标签剥离为同步纯函数,O(n) 字符扫描,零网络。omni 首音不被阻塞。
- **依赖/锁决策**:不引入新依赖;尊重 Anthropic tool-use+MCP、Pipecat 帧管线、SQLite 真相源、Neuro 专有机制暂挂(🅽)。
