## ADDED Requirements

### Requirement: EchoGuard 纯函数去抖 Gate(connected N 帧确认)

`@chat-a/voice-detect` SHALL 提供纯函数确定性去抖件 `EchoGuardGate`(无副作用、无时钟,与 `VadGate` 同范式),用于在 agent 说话期对 barge-in 施加「连续 N 帧高置信语音」确认。Gate 逐帧喂入 `{ prob, energy01, speakingFromVad }`,返回 `{ confirmed, run }`:仅当**连续** `confirmFrames`(N)帧满足「`prob ≥ minSpeechProb` 且 `speakingFromVad` 为真 且(`minEnergy ≤ 0` 或 `energy01 ≥ minEnergy`)」时 `confirmed` 为真;任一帧不达标即把连续计数清零。Gate MUST 提供 `reset()` 清连续计数。配置经 `EchoGuardConfig`(`enabled` / `confirmFrames` / `minSpeechProb` / `minEnergy`),全字段外置无 magic number,并提供 `DEFAULT_ECHO_GUARD_CONFIG`(`enabled:false` / `confirmFrames:1` / `minSpeechProb:0.5` / `minEnergy:0`,安全默认)。

#### Scenario: 禁用即时确认

- **WHEN** `enabled:false` 喂任意帧
- **THEN** `confirmed` 恒为真(等价无去抖,逐字现状)

#### Scenario: N=1 首帧即确认

- **WHEN** `confirmFrames:1`、喂一个 `prob ≥ minSpeechProb` 且 `speakingFromVad` 的帧
- **THEN** 该帧即 `confirmed:true`(与既有「检出语音即打断」时序一致)

#### Scenario: N=3 需连续三帧

- **WHEN** `confirmFrames:3`,喂连续 3 帧高置信语音
- **THEN** 第 3 帧 `confirmed:true`;若其中插入一个低置信/静音帧 → 计数清零,需重新连续 3 帧才确认

#### Scenario: 能量阈值过滤低能量回声

- **WHEN** `minEnergy > 0`,某帧 `prob` 达标但 `energy01 < minEnergy`
- **THEN** 该帧不计入连续帧,`run` 清零(典型回声经空气衰减能量偏低,被滤除)

### Requirement: VoiceLoop speaking 期经 EchoGuard 确认才打断

`VoiceLoop` SHALL 支持可选构造项 `echoGuard?: EchoGuardConfig`。**未注入时**,`speaking` 期 barge-in 行为逐字不变(检出语音即按既有路径打断;等价 N=1 即时确认)——既有 barge-in 回归用例 MUST 全绿。**注入时**,`speaking` 期检出的上行语音帧先喂 `EchoGuardGate`,仅当 Gate `confirmed` 后才进入既有打断路径(未注入 attention → 即时 `#interrupt`;注入 attention → 再经 `evaluateAttention` 按 `attention_mode` 判)。Gate 未确认时 MUST 保持 `speaking`(只感知不打断,不写半句、不 clearBuffer)。`listening` / `endpointing` 期 MUST NOT 经 EchoGuard——端点检测灵敏度逐字不变。EchoGuard 连续计数 MUST 在进入/离开 `speaking`(打断、回合结束、降级回 listening)时 `reset()`。

#### Scenario: 未注入即现状

- **WHEN** 不传 `echoGuard`,`speaking` 期检出语音起点
- **THEN** 行为与现状完全一致(即时进 barge_in_pending → 打断),既有 barge-in 测试时序不变

#### Scenario: 说话期回声样式被压制

- **WHEN** 注入 `echoGuard{enabled:true, confirmFrames:3}`,`speaking` 期喂入断续(连续达标不足 3 帧)的回声样式帧序列
- **THEN** 保持 `speaking`,不打断、不 clearBuffer、不写半句记忆

#### Scenario: 真人连续 N 帧仍能打断

- **WHEN** 同上配置,`speaking` 期喂入连续 ≥ `confirmFrames` 帧高置信语音
- **THEN** 确认真打断:进 barge_in_pending → 回 `listening`,clearBuffer + 半句写回(证明「打得断」,未被削弱成打不断)

#### Scenario: 非说话期灵敏度不变

- **WHEN** 注入 `echoGuard` 后驱动 `listening`/`endpointing` 期的正常端点检测闭环
- **THEN** 结果与未注入 EchoGuard 时一致(EchoGuard 只在 `speaking` 期生效)

### Requirement: 危机/硬打断豁免 EchoGuard 去抖

当 `speaking` 期且注入了 attention 信号通道、其 `buildSignal` 产出的 `UserVoiceSignal` 带 `crisis` 或 `hardInterrupt` 标注时,VoiceLoop MUST **绕过 EchoGuard 的 N 帧去抖**立即进入打断判定(承「救命不可配」§法律底线)——危机/硬打断不被自打断防护拖延。

#### Scenario: 硬打断不被 N 帧拖延

- **WHEN** 注入 `echoGuard{confirmFrames:3}` 且 attention `buildSignal` 标 `hardInterrupt:true`,`speaking` 期单帧检出语音
- **THEN** 立即真打断(不等待连续 3 帧),回 `listening`
