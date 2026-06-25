## Why

根因调查 B 揭示:情绪难随对话动,部分因 persona 内核几个**关键参数硬编码、无配置接缝**:
- **冷启动窗口** `coldStartTurns=5` / `coldStartReboundFactor=2`(`defaults.ts:16-17`):前 5 轮情绪幅度减半(amp×0.5)、回弹翻倍(k×2);叠加 desktop 内存后端每次重启 turn 归 0 → 永远困在冷启动 → 情绪被压制。
- **情绪离散阈值** `0.35`/`0.25`(`numeric.ts:66-67` `padToEmotion` 硬编码):基线常落 neutral,跨阈难。

现有只有 5 个 dial(warmth/expressiveness/volatility/intensity/negativeAffect)有 env(`config-loader.ts:25-32`),coldStart/阈值**改不了**。承 §3.2「行为即配置:阈值/参数外置、杜绝 magic number」,把这几个暴露为配置 → 可在不改代码的情况下调"情绪有多容易动",便于真机调优(及未来人格化差异)。

## What Changes

- **PersonaConfig 暴露 coldStart 参数 + 情绪阈值**:`coldStartTurns`/`coldStartReboundFactor`(PersonaConfig 已有字段,但无 env 装配)、`padToEmotion` 的正/负阈值(现硬编码)提进 PersonaConfig(或一个 EmotionThresholds 结构),`config-loader` 加 env(如 `CHAT_A_COLD_START_TURNS` / `CHAT_A_EMOTION_THRESHOLD`)。
- **默认值 = 现值**(coldStartTurns=5、阈值 0.35/0.25)→ 不设 env **逐字回归**;`padToEmotion` 改为读配置而非常量(默认仍 0.35)。
- **golden 不变**:默认参数下所有现有 padToEmotion/stepPad golden 测逐字通过;新增"调阈值/关冷启动后行为按预期变"的测试。

## Capabilities

### Modified Capabilities
- `persona-emotion`: `coldStartTurns`/`coldStartReboundFactor` 与情绪离散阈值成为可配置项(行为即配置),经 env 装配;默认 = 现值,零回归。

## Impact

- **改动代码**:`packages/persona/src/numeric.ts`(`padToEmotion` 读阈值参数)、`types.ts`/`defaults.ts`(PersonaConfig 加阈值字段 + 默认)、`config-loader.ts`(env 装配)、engine 把配置透传给 padToEmotion 调用点(tone()/advance())。
- **canonical 接缝**:§3.2(行为即配置/杜绝 magic number)、§6(PAD)。
- **风险**:padToEmotion 现是无参纯函数、多处调用(engine.tone/numeric);改为带阈值参数需逐点透传——注意全调用点(含 padToVoiceInstruction 复用 padToEmotion)。默认值保证零回归。
- **非目标**:不改情绪映射/弹簧公式本身;不碰 R1 持久化(turn 归零问题在持久化修好后自然缓解,本 change 只让冷启动可关/可调);不做 baseline 随 warmth 变更重算(R5,另议)。
