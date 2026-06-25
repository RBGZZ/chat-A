## ADDED Requirements

### Requirement: omni 直路把用户语气情绪经显式标签喂进 PAD(prosody→PAD)

omni audio-in 直路(path B)SHALL 把用户说话的语气情绪经**显式机读标签链路**喂进 PAD 情感内核,落地 canonical §7 底线「带情绪的语音(prosody)永不漏听」。该能力为**纯加法**:在**不注入** `advanceProsody` 钩子、模型**未给**标签、或标签**解析失败**的任一情形下,omni 直路的行为与产出 MUST 与本能力引入前**逐字一致**(仅没有 prosody→PAD,等于现状)。

落地分三处:

1. **omni instructions 注入标签门控指令**:omni 直路系统提示组装(`composeOmniInstructions`)SHALL 在末尾追加一段指令,要求模型在回复**末尾**附一个机读标签 `[user_emotion:<label>-<intensity>]`——`label` 取与 STT 一致的 7 类情绪集合(`surprised`/`neutral`/`happy`/`sad`/`disgusted`/`angry`/`fearful`),`intensity` 为 1–10 的整数。该指令 MUST **仅作用于 omni 直路**;STT 路与文字路的系统提示 MUST NOT 受其影响(`Conversation.send` 走的 `composeSystem` 不注入此指令)。

2. **VoiceLoop 剥标签**:omni 回合累积回复时,`VoiceLoop` SHALL 以一个确定性纯函数从**回复尾部**解析 `[user_emotion:...]` 标签,并在喂 TTS、写显示/记忆之前将其**剥除**。标签 MUST NOT 被合成念出、MUST NOT 进入半句写回的记忆内容。多个标签出现时取**最后一个**;畸形/无标签 → 视作无情绪(零拉力)。

3. **可选钩子推进 PAD**:`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**钩子 `advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>`。当注入了该钩子且 omni 回合解析出合法情绪时,`VoiceLoop` MUST 把映射好的 `SttEmotionLike` 喂给它(由装配层接到 persona 的 prosody-only 推进通道,复用现成 `prosodyToPadPull`,不新写映射)。钩子缺省不注入时 MUST 不调用(omni 路逐字现状)。钩子抛错/拒绝 MUST 被捕获且 MUST NOT 中断回合(§3.2 降级)。

本能力 MUST NOT 改动 STT 路径,MUST NOT 新增 `VoiceState` 或 `VoiceBusEvent`,MUST NOT 在本切片做 omni 路的 persona 全演化/亲密度推进/助手写记忆(那是更大范围,明确不做)。

#### Scenario: 未注入钩子 → omni 路逐字现状

- **WHEN** 不注入 `advanceProsody` 钩子、语音路径为 omni,驱动一个完整 omni 回合(模型回复尾部即便带标签)
- **THEN** 钩子零调用、PAD 不被本链路推进;回复中的标签仍被剥除后再进 TTS/显示(绝不念出标签),其余产出与本能力引入前一致

#### Scenario: 模型给标签 → 剥离后喂 PAD

- **WHEN** 注入 `advanceProsody` 钩子、omni 端口的 `text` 事件累积成形如 `…正文…[user_emotion:sad-7]` 的回复
- **THEN** `VoiceLoop` 从尾部解析出 `{label:'sad', confidence≈0.7}` 并调用 `advanceProsody`;喂 TTS 的句子与累积文本中**不含**该标签(标签不被念出、不进记忆)

#### Scenario: 无标签 / 畸形标签 → 零情绪降级

- **WHEN** 模型回复**不含** `[user_emotion:...]` 标签,或标签 label 不在 7 类集合内 / intensity 非法
- **THEN** `advanceProsody` 不以非法情绪被调用(无标签时不调用;label 非法时按零情绪处理,不污染 PAD);回复正文照常进 TTS/显示,回合不受影响

#### Scenario: 多标签取最后一个

- **WHEN** 回复中出现多个 `[user_emotion:...]` 标签
- **THEN** 解析取**最后一个**标签作为本轮 prosody 情绪;所有标签均从进 TTS/显示的文本中剥除

#### Scenario: 钩子抛错不中断回合

- **WHEN** 注入的 `advanceProsody` 钩子在被调用时抛错或返回 rejected Promise
- **THEN** 错误被捕获并记 warn,omni 回合照常推进(分句→TTS→收尾),绝不崩

#### Scenario: 标签指令仅作用 omni 路

- **WHEN** 走 STT 路径或文字路径(`Conversation.send`)产出系统提示
- **THEN** 系统提示中**不含** `[user_emotion:...]` 标签指令(STT 路情绪来自 qwen-asr,文字路无语音),其产出与本能力引入前逐字一致
