## Context

`padToEmotion`(`numeric.ts:64-68`)是无参纯函数,阈值 0.35/0.25 硬编码;`coldStartTurns=5`/`reboundFactor=2` 在 `DEFAULT_PERSONA_CONFIG`(`defaults.ts:16-17`),PersonaConfig 有字段但 `config-loader` 未从 env 装配。`config-loader` 现只装 5 个 dial(`:25-32`)。承 §3.2 行为即配置。`padToEmotion` 复用方:`engine.tone()`(:113)、`padToVoiceInstruction`(本会话新增,内部调 padToEmotion)。

## Goals / Non-Goals

**Goals:** coldStart 参数 + 情绪阈值可经 env 调;默认=现值零回归;单一权威(阈值一处定、各调用点共用)。
**Non-Goals:** 不改弹簧/映射公式;不碰持久化(R1);不做 warmth 变更重算 baseline(R5,另议)。

## Decisions

### D1:阈值进 PersonaConfig,padToEmotion 带参
`PersonaConfig` 加 `emotion: { pleasureThreshold: 0.35, arousalThreshold: 0.25 }`(或扁平字段),默认入 `DEFAULT_PERSONA_CONFIG`。`padToEmotion(pad, thresholds?)` 加可选阈值参(缺省回落 0.35/0.25 → 纯函数默认行为不变,便于现有无参调用点逐步迁移)。
- **为何可选参 + 默认常量**:既让配置生效,又**不强制改所有调用点**(无参调用仍用默认 → 回归);engine/padToVoiceInstruction 显式传 config 阈值。

### D2:config-loader 装 env
加 `CHAT_A_COLD_START_TURNS` / `CHAT_A_COLD_START_REBOUND` / `CHAT_A_EMOTION_PLEASURE_THRESHOLD` / `CHAT_A_EMOTION_AROUSAL_THRESHOLD`(数值解析,非法/缺省回落现值)。装进 PersonaConfig + 透传 padToEmotion。

### D3:单一权威透传(审查坐实 4 调用点 + 完整 config 装配链)
**padToEmotion 生产调用点共 4 处**(审查 grep 坐实):`engine.tone()`(engine.ts:130)、`padToVoiceInstruction`(pad-voice-instruction.ts)、**`renderToneFragment`(tone.ts:57,原 design 漏列——它产系统提示情绪文案,不透传会与显示情绪不一致)**、及后者内部。全部接 config 阈值。
**config 装配链(比"config-loader 加 env"大)**:`loadPersonaFromEnv` 现只产 seed/dials、不产 PersonaConfig;PersonaEngine 三构造点(app.ts:200/280、conversation.ts:298)都不传 config(回落 DEFAULT)。需:新 `loadPersonaConfigFromEnv` → 透传到这三处 + **`Conversation` 构造新增 config 入参**(TurnDeps.personaConfig)。`stepPad` 已从 config 读 coldStart,不改。

### D4:posture 阈值耦合的取舍
`posture.ts:22 ceilHigh=-0.35` 注释自承"与 padToEmotion 负面边界一致"。本 change **决定:posture 阈值独立、不随情绪 pleasure 阈值动**(posture 不在本 spec 范围;若联动是另一致性议题)——在代码/文档标注此取舍,避免误以为自动同步。

## Risks / Trade-offs
- padToEmotion 多调用点透传遗漏 → 显示情绪与映射不一致。**对策**:可选参默认=现值(漏传也不回归),但要把 engine/padToVoiceInstruction 显式接上;加测试断言一致。
- 调过头(阈值太低)→ 情绪乱跳。属用户调参自负,默认安全。

## Migration Plan
- 纯增量 + 默认现值。无 schema 迁移(PersonaConfig 是运行时配置非持久 schema)。回滚=去 env / revert。

## Open Questions
- 阈值结构扁平 vs 嵌套(emotion:{...})——apply 时按 PersonaConfig 现有风格定。
- 是否一并暴露 emotionalIntensity 之外的 stepPad 系数——本次只 coldStart+阈值,其余按需。
