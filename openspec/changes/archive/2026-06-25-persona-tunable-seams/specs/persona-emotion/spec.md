## ADDED Requirements

### Requirement: 冷启动参数与情绪阈值可配置

persona 内核 SHALL 把冷启动窗口参数(`coldStartTurns`、`coldStartReboundFactor`)与情绪离散阈值(`padToEmotion` 的正/负 pleasure 阈值、arousal 阈值)暴露为配置项(PersonaConfig),经 env 装配。**默认值 SHALL 等于现值**(coldStartTurns=5、reboundFactor=2、pleasure 阈值 0.35、arousal 阈值 0.25);不设配置时行为与本能力引入前**逐字一致**。`padToEmotion` SHALL 据配置阈值判定(默认仍 0.35/0.25)。

#### Scenario: 默认零回归
- **WHEN** 不设任何相关 env
- **THEN** coldStart/阈值取现值,`padToEmotion`/`stepPad` 产出与现状逐字一致(现有 golden 全过)

#### Scenario: 调低阈值 → 情绪更易触发
- **WHEN** 配置 pleasure 阈值降到 0.25
- **THEN** 基线 pleasure 0.34 的状态 `padToEmotion` 返回 content(而非 neutral)

#### Scenario: 关闭冷启动 → 前几轮不再被压制
- **WHEN** 配置 coldStartTurns=0
- **THEN** 首轮起 stepPad 不施加 amp×0.5 / k×rebound 的冷启动压制(步幅/回弹按常规)

#### Scenario: 阈值参数透传到所有调用点
- **WHEN** padToEmotion 被 engine.tone / padToVoiceInstruction 等调用
- **THEN** 各处用同一配置阈值(单一权威),不残留硬编码 0.35
