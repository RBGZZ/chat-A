## MODIFIED Requirements

### Requirement: 决策链完整且无条件全量

`DecisionTrace` SHALL 承载重建一个回合所需的完整决策链:`correlationId`、OTel `traceId`/`spanId`(缝合键)、`sessionId`、`turnId`、时间戳、用户输入、**召回记忆及打分**(文本/kind/subject/hits)、**当时情绪**(emotion 及可得的 PAD)、`assertiveness`、**stance 命中观点**、**当轮负面姿态 `posture`**(sulking/withdrawn,无则空)、**最终组装的 system 与 messages**、Provider id 与 model、**LLM 原始回复**、回合延迟。写入 SHALL **无条件全量、不采样**(承"可重放绝不靠 OTel")。本地捕获的完整 prompt SHALL 只落本地 SQLite、绝不导出远端。

#### Scenario: 落库记录可重建该回合

- **WHEN** 一个回合的决策被写入
- **THEN** 该记录含组装出的 system/messages、召回记忆、情绪、stance、posture、Provider/model 与回复,足以回答"她为什么这么说"

#### Scenario: 与 OTel 同 ID 缝合

- **WHEN** 决策被写入且本回合存在 OTel span
- **THEN** 记录中的 `traceId`/`spanId` 与该回合 OTel span 的一致,可由 OTel 跳转回 SQLite

#### Scenario: 负面姿态随情绪落库

- **WHEN** 某回合处于负面姿态(sulking/withdrawn)且被写入
- **THEN** 记录的 `posture` 为该姿态;无姿态时为空(可空列)
