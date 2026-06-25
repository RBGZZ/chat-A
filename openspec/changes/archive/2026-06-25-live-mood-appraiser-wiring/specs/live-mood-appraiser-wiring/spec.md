## ADDED Requirements

### Requirement: 情绪随对话起伏并被显示/朗读读到

desktop 下,小雪的 PAD 情绪 SHALL 能随对话内容真实起伏,且 mood 显示与 emotion-aware-voice 朗读 SHALL 读到**当前活 PAD**(而非开机快照)。该端到端贯通 SHALL 由两部分保证:① 情绪评估器接入核心装配;② 只读 mood 取数反映已推进并持久化的 PAD。默认配置(不开 LLM appraiser)SHALL 行为与现状一致(默认关键词 appraiser),且活 PAD 取数对"取数本就等于持久化值"的情形无可观察行为变化。

#### Scenario: 开 LLM appraiser 后情绪随对话动
- **WHEN** `CHAT_A_APPRAISER=llm`,用户连发明显情绪倾向的话
- **THEN** 小雪 PAD 随之推进,mood 显示与朗读情绪指令反映新的心情(非恒"平静")

#### Scenario: 回合后读到活 PAD
- **WHEN** 一个文字回合结束(persona 已 advance 并持久化)
- **THEN** 随后的 mood 显示 / emotion-aware-voice 朗读读到的是该回合后的 PAD,不是开机快照

#### Scenario: 默认零回归
- **WHEN** 未设 `CHAT_A_APPRAISER`(默认)
- **THEN** 走默认关键词 appraiser,情绪推进与本能力引入前一致;活 PAD 取数不改变任何既有产出
