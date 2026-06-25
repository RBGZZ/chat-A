## ADDED Requirements

### Requirement: omni 直路回合收尾与 STT/文字路对齐(单一记忆/人格真相源)

omni audio-in 直路(path B)的回合在**自然结束**(`end` 事件 / 流自然结束、句出尽后)时,`VoiceLoop` SHALL 经一个注入的「外部已生成回复收尾」接缝,把本轮收尾对齐 STT/文字路经 `finalizeTurn` 跑完的全套人格/记忆演化——即 MUST 完成:写 user 消息 + 写 assistant 消息、文本情绪评估(appraiser→PAD)、把本轮语音 prosody 情绪并入 PAD、写记忆(`writeMemories`)、关系亲密度抬升(closeness)、立场强度演化、自我一致性检查(若接了 Guard)、决策 trace 落库、写侧 embedding(若启用语义)。该收尾 MUST NOT 重新调用 LLM(omni 回复已由 `respondToAudio` 生成)。

`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**接缝 `finalizeTurn?: (userText: string, reply: string, opts?: { readonly prosodyEmotion?: SttEmotionLike }) => void | Promise<void>`。当注入且走 omni 直路时,`VoiceLoop` MUST 在回合自然结束收尾处以 `userText`=本轮 omni transcript、`reply`=剥标签后的累积干净回复、`opts.prosodyEmotion`=本轮解析出的语气情绪(若有)调用一次该接缝。该接缝为**纯加法**:未注入(`finalizeTurn===undefined`)时 omni 直路的收尾 MUST NOT 因本能力新增任何收尾副作用(降级行为见下)。接缝抛错/拒绝 MUST 被捕获且 MUST NOT 中断回合(§3.2 降级)。

#### Scenario: 注入收尾接缝 → omni 回合自然结束时对齐全套收尾

- **WHEN** 注入 `finalizeTurn` 接缝、语音路径为 omni,驱动一个完整 omni 回合(产出 transcript + 回复文本 + end)
- **THEN** 回合句出尽后该接缝被调用且仅一次,入参 `userText` 为本轮 transcript、`reply` 为剥标签后的回复;由其完成写 user+assistant 消息、文本评估、prosody 并入 PAD、写记忆、closeness 抬升、立场演化、决策 trace 等收尾

#### Scenario: 收尾接缝不重新调用 LLM

- **WHEN** 走 omni 直路且回合结束触发收尾
- **THEN** 收尾过程 MUST NOT 触发任何新的 `llm.stream` / LLM 生成调用(omni 回复已生成,收尾只落库/演化)

#### Scenario: 收尾接缝抛错不中断回合

- **WHEN** 注入的 `finalizeTurn` 接缝在被调用时抛错或返回 rejected Promise
- **THEN** 错误被捕获并记 warn,omni 回合照常完成(已播出的回复不受影响)、状态干净回 listening,绝不崩

#### Scenario: 未注入收尾接缝 → 不新增收尾副作用

- **WHEN** 不注入 `finalizeTurn` 接缝、语音路径为 omni,驱动一个完整 omni 回合
- **THEN** 本能力不引入任何额外收尾副作用(回合按既有最小路径收尾回 listening),行为相对未引入本能力时无回归

### Requirement: omni 直路不再手动半套写记忆(消息写入收口到收尾)

omni 直路 MUST NOT 在 `transcript` 事件里手动 `appendMessage(role:'user')`;本轮 user 与 assistant 消息的落库 MUST 由回合收尾(经注入的 `finalizeTurn` 接缝)统一完成(与 STT/文字路一致:回合末尾一次写两条)。这消除 user 消息重复落库,并补齐此前**完全缺失**的 assistant 回复落库(omni 路助手回复此前不进记忆/召回)。

被打断回合的「半句写回」路径 MUST 保持不变(仍在 `#interrupt` 里以 `role:'assistant'` + `[被用户打断]` 写半句,不经收尾接缝)。

#### Scenario: omni 正常回合写入 user + assistant 两条消息

- **WHEN** 注入收尾接缝、omni 回合自然结束(未被打断)
- **THEN** 记忆中本轮恰有一条 `role:'user'`(=transcript)与一条 `role:'assistant'`(=剥标签后回复),user 消息不重复落库

#### Scenario: 未注入收尾接缝时不重复写 user 消息

- **WHEN** 不注入收尾接缝、omni 回合结束
- **THEN** omni 路不再在 transcript 事件手动写 user 消息(避免与收尾重复);其余行为无回归

#### Scenario: 被打断回合仍写半句(路径不变)

- **WHEN** omni 回合 speaking 中被 barge-in 打断(已累积半句)
- **THEN** 半句带 `[被用户打断]` 经 `#interrupt` 以 assistant 角色写回记忆,不调用收尾接缝(收尾仅在自然结束触发)

### Requirement: prosody 情绪经收尾收口为单一推进(取代 P1 旁路)

omni 路本轮语音 prosody 情绪(经 `[user_emotion:...]` 标签剥出)MUST 经回合收尾接缝的 `opts.prosodyEmotion` 与文本评估**在同一次** `persona.advance(userText, { prosodyEmotion })` 合并并入 PAD(与 STT 路同源),MUST NOT 再走独立旁路重复推进 PAD(避免双步进漂移)。标签的**剥离**(不进 TTS/显示/记忆)与 omni instructions 的标签门控指令 SHALL 保留;仅其出口从独立的 prosody-only 推进改接到收尾接缝。

#### Scenario: prosody 与文本评估合并并入 PAD(不双步进)

- **WHEN** 注入收尾接缝、omni 回合解析出合法 `[user_emotion:label-intensity]`
- **THEN** 该情绪经收尾接缝的 `prosodyEmotion` 与本轮文本一起经**一次** `persona.advance` 并入 PAD;PAD 不被同一情绪重复推进两次

#### Scenario: 标签仍被剥离不进 TTS/记忆

- **WHEN** omni 回复尾部含 `[user_emotion:...]` 标签
- **THEN** 标签从进 TTS/显示/写入记忆的回复文本中被剥除(`reply` 入参为干净文本),仅其情绪经 `prosodyEmotion` 透传

#### Scenario: 无标签 → prosodyEmotion 缺席,收尾照常

- **WHEN** omni 回复不含合法情绪标签
- **THEN** 收尾接缝以无 `prosodyEmotion`(缺席)被调用,文本评估等其余收尾照常完成,PAD 仅受文本评估推进
