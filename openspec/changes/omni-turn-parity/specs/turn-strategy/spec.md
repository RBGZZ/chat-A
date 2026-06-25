## ADDED Requirements

### Requirement: Conversation 暴露「外部已生成回复、只走收尾」入口 finalizeExternalTurn

`Conversation` SHALL 暴露方法 `finalizeExternalTurn(userText: string, reply: string, opts?: { readonly prosodyEmotion?: SttEmotionLike }): Promise<void>`,供「自带回复、不经 `send` 调 LLM」的回合(如 omni audio-in 直路,及未来其它直路)复用与 `send` **同一套**回合收尾真相源。该方法 MUST **复用**既有 `finalizeTurn`(`turn-shared`)的全部收尾步骤:写 user + assistant 消息、文本情绪评估(`persona.advance`)、把 `opts.prosodyEmotion`(若有)在同一次 `persona.advance` 并入 PAD、`writeMemories`、closeness 抬升、立场强度演化、自我一致性检查(若接了 Guard)、决策 trace 落库、写侧 embedding(若启用语义)。

该方法 MUST NOT 调用 LLM、MUST NOT 开 `llm` 子 span、MUST NOT 重新生成回复(回复由调用方提供)。它 SHALL 自行补齐 `finalizeTurn` 所需的回合上下文:开自己的 `turn` span 与 correlationId(emit `turn:start`/`turn:end`)、读 mood/closeness、`detectStance(userText)`、关键词召回(不引入新的语义嵌入网络阻塞,§5.5)、并使用 `Conversation` 内部回合序号。该方法 MUST 整体优雅降级:任一收尾步骤失败 MUST 记 warn 且 MUST NOT 上抛(§3.2),使调用方回合不被收尾失败拖垮。

该方法 MUST NOT 改变 `Conversation.send` 的签名与行为;STT 路 / 文字路 MUST 继续走 `send`,MUST NOT 经过 `finalizeExternalTurn`。

#### Scenario: 外部回复经 finalizeExternalTurn 走完整收尾

- **WHEN** 以 `userText`、`reply`(及可选 `prosodyEmotion`)调用 `conversation.finalizeExternalTurn(...)`
- **THEN** 记忆落入一条 user 消息(=userText)与一条 assistant 消息(=reply),persona 经文本评估(及 prosody 若有)推进 PAD,closeness 抬升、立场演化、决策 trace 等收尾按 `finalizeTurn` 既有逻辑完成

#### Scenario: finalizeExternalTurn 不触发 LLM

- **WHEN** 调用 `finalizeExternalTurn`
- **THEN** 不发生任何 `llm.stream` / LLM 生成调用,也不开 `llm` 子 span(回复由调用方提供,收尾只落库/演化)

#### Scenario: prosodyEmotion 与文本评估合并并入 PAD

- **WHEN** 以 `opts.prosodyEmotion` 提供合法语音情绪调用 `finalizeExternalTurn`
- **THEN** 该情绪与 `userText` 在**同一次** `persona.advance(userText, { prosodyEmotion })` 合并并入 PAD,与 STT 路第 4 参语义同源,不重复推进

#### Scenario: 收尾步骤失败优雅降级不上抛

- **WHEN** 收尾过程中某一步(如写记忆 / trace / embedding)抛错
- **THEN** 错误被捕获并记 warn,`finalizeExternalTurn` 不上抛,其余可完成的收尾步骤照常完成

#### Scenario: 不影响 send / STT / 文字路

- **WHEN** 经 `send` 跑 STT 路或文字路回合
- **THEN** 这些回合不经过 `finalizeExternalTurn`,其收尾经既有 `send → strategy → finalizeTurn` 完成,行为与本变更前逐字一致
