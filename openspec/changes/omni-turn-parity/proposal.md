## Why

omni 语音多模态直路(path B,`CHAT_A_VOICE_PATH=omni`)的回合在 `VoiceLoop.#startThinkingOmni`(`packages/runtime/src/voice-loop.ts`)里**自带 LLM 生成、不走 `conversation.send`**,因此 STT 路/文字路经 `Conversation.send → strategy → finalizeTurn` 跑完的「一整套人格/记忆演化收尾」在 omni 路上**几乎整条缺失**。刚归档的 P1(`omni-prosody-to-pad`)只补了「用户语气情绪 → PAD」这一条(经 `advanceProsody` 钩子),其余收尾仍旁落。后果是:**走 omni 时,小雪「记不住自己刚说过什么」(助手回复不进记忆/召回)、心情只受语气不受对话内容驱动(无文本评估)、关系永远不升温(closeness 不抬)、立场不演化、自我一致性不锚定、决策不可追溯(无 trace)**——这正违背北极星「长期伴侣」与 canonical §5/§6/§7/§8.1 的真相源单一性。

本变更即「option B」:让 omni 路在**人格演化与记忆行为**上与 STT/文字路对齐(单一 PAD/记忆真相源),不再是「裸多模态绕过认知栈」。

## What Changes

- **抽出「外部已生成回复、只走收尾」的公共入口**:新增 `Conversation.finalizeExternalTurn(userText, reply, opts?)`(opts 含可选 `prosodyEmotion`),内部复用既有 `finalizeTurn`(`packages/runtime/src/turn-shared.ts`)的全部收尾——写 user/assistant 消息、文本情绪评估(`persona.advance` 文本拉力)、并入语音 prosody 拉力、`writeMemories`、closeness 抬升、立场演化、自我一致性 Guard、决策 trace、写侧 embedding。**关键**:omni 自带回复,不能套用 `send` 里「调 LLM」那段;`finalizeExternalTurn` 只跑收尾、**不**开 llm span、**不**调 `llm.stream`。
- **omni 回合收尾改走该入口**:`#startThinkingOmni` 在回合结束(`end`/流自然结束、等句出尽后)用累积好的 `transcript`(userText)+ 剥标签后的干净回复(reply)+ 解析出的 prosody 情绪,调一次 `finalizeExternalTurn`。
- **移除 omni 路的「手动半套写记忆」**:omni 路当前在 `transcript` 事件里手动 `appendMessage(role:'user')`、且**从不写 assistant 回复**;改为统一由 `finalizeExternalTurn` 写两条消息(避免 user 消息重复落库 + 补上缺失的 assistant 落库)。
- **P1 的 prosody→PAD 钩子收敛**:P1 的 `advanceProsody`(只推进 PAD、不写记忆/不抬 closeness)被 `finalizeExternalTurn` 的统一收尾**取代**(prosody 情绪改由 `finalizeExternalTurn` 的 `prosodyEmotion` 形参经 `finalizeTurn` 并入,与 STT 路同源,杜绝「两套 prosody 推进」漂移)。`advanceProsody` 钩子接缝可保留为兼容空位或废弃(见 design 取舍)。
- **门控**:omni 路本就 opt-in(`CHAT_A_VOICE_PATH=omni` 且端口构造成功);本变更**只触 omni 收尾分支**,STT 路/文字路的 `send`/`finalizeTurn` 调用形状逐字不变。

## Capabilities

### New Capabilities
<!-- 无新增 capability;复用既有 turn-strategy(finalizeTurn 收尾)与 voice-mode-wiring 的 omni 路接缝。 -->

### Modified Capabilities

- `voice-mode-wiring`: omni audio-in 直路(path B)的回合收尾要求**对齐 STT/文字路**——经新公共入口 `Conversation.finalizeExternalTurn` 完成「写 user+assistant 消息、文本情绪评估、prosody 并入 PAD、写记忆、closeness 抬升、立场演化、自我一致性、决策 trace」;omni 路不再手动半套写记忆;缺省/降级零回归约束。
- `turn-strategy`: `Conversation` 新增「外部已生成回复、只走收尾」的公共入口 `finalizeExternalTurn`,**复用** `finalizeTurn` 全部收尾步骤,但**不**调 LLM、不开 llm span——使「自带回复的回合」(omni,及未来其它直路)能与 `send` 共享单一收尾真相源。

## Impact

- **canonical 章节/接缝**:落地 §5(记忆:助手回复入库/召回)、§6(人格:文本评估 + PAD + closeness)、§7#3(立场演化)/§7#5(prosody)、§6.1 自我一致性、§8.1 决策 trace——把这些真相源在 omni 路收口为**单一**(与 STT/文字路同一 `finalizeTurn`),消除「omni 旁路绕过认知栈」。
- **代码**:`packages/runtime/src/conversation.ts`(新增 `finalizeExternalTurn` 方法 + 暴露收尾所需依赖)、`packages/runtime/src/turn-shared.ts`(可能小重构:把 `finalizeTurn` 的 mood/stance 准备步骤抽成可被 `finalizeExternalTurn` 复用的形态)、`packages/runtime/src/voice-loop.ts`(`#startThinkingOmni` 收尾改走新入口 + 移除手动 `appendMessage`)、`packages/client/src/cli-voice.ts` 与 `packages/client/src/assembly/app.ts`(接线:把 `finalizeExternalTurn` 注入 omni 路,替代/补充 `advanceProsody`)。可能小动 `packages/desktop/src/main.ts`(若复用同套 omni 装配)。
- **延迟预算(§3.2)**:收尾在回合**末尾**(回复已出尽、TTS 已下行),**不在首字/首音热路径**;`finalizeTurn` 内部各步已是「首字之后、失败降级、写侧 embedding fire-and-forget」。omni 首音不被本变更阻塞。新增的文本评估对空 userText 不再发生(omni 现在有真 transcript),评估走确定性 appraiser(默认极快)。
- **零回归边界**:STT 路/文字路绝不经过 `finalizeExternalTurn`;omni 路未注入新入口时**降级回 P1 行为或干净收尾**(design 写明)。`finalizeExternalTurn` 各步失败均降级不崩(§3.2)。
- **依赖/锁决策**:不引入新依赖;尊重 Anthropic tool-use+MCP、Pipecat 帧管线(本变更在 A 层/回合收尾,不串 B 层帧)、SQLite 真相源(收尾即写真相源)、Neuro 专有机制暂挂(🅽)。
