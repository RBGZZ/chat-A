## ADDED Requirements

### Requirement: assembleApp 按配置装配情绪评估器

`assembleApp` SHALL 按 `CHAT_A_APPRAISER` 装配情绪评估器:`=llm` 时构造 LLM 评估器(复用现有 provider)并经会话工厂注入 Conversation(`TurnDeps.appraiser`);否则不注入(默认关键词评估器,逐字现状)。注入 SHALL 在所有重建会话的路径(reset / applyPersona / applyLang)中一致续接。

#### Scenario: llm 模式注入评估器
- **WHEN** `CHAT_A_APPRAISER=llm`
- **THEN** assembleApp 构造的 Conversation 持有 LLM 评估器,回合推进 PAD 用它

#### Scenario: 缺省不注入
- **WHEN** 未设 `CHAT_A_APPRAISER`
- **THEN** 不注入评估器,Conversation 用默认关键词评估器(行为与现状一致)

#### Scenario: 重建会话续接
- **WHEN** reset / applyPersona / applyLang 重建 Conversation
- **THEN** 评估器装配在重建后仍按同一配置续接(不丢失)
