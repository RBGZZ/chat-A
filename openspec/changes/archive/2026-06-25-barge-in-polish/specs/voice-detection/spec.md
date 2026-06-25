## MODIFIED Requirements

### Requirement: EchoGuard 纯函数去抖 Gate(connected N 帧确认)

`@chat-a/voice-detect` SHALL 提供纯函数确定性去抖件 `EchoGuardGate`(无副作用、无时钟,与 `VadGate` 同范式),用于在 agent 说话期对 barge-in 施加「连续 N 帧高置信语音」确认。Gate 逐帧喂入 `{ prob, energy01, speakingFromVad }`,返回 `{ confirmed, run }`:仅当**连续** `confirmFrames`(N)帧满足「`prob ≥ minSpeechProb` 且 `speakingFromVad` 为真 且(`minEnergy ≤ 0` 或 `energy01 ≥ minEnergy`)」时 `confirmed` 为真;任一帧不达标即把连续计数清零。Gate MUST 提供 `reset()` 清连续计数。配置经 `EchoGuardConfig`(`enabled` / `confirmFrames` / `minSpeechProb` / `minEnergy`),全字段外置无 magic number,并提供 `DEFAULT_ECHO_GUARD_CONFIG`(`enabled:false` / `confirmFrames:1` / `minSpeechProb:0.5` / `minEnergy:0`,安全默认)。

`DEFAULT_ECHO_GUARD_CONFIG.confirmFrames` MUST 保持为 `1`:它是**库级回归硬线**——与 `enabled:false` 配套,直接构造/外部注入 Gate 时给出「等价无去抖、逐字现状」的安全起点,不应擅自改变既有时序。**真正的去抖默认值提升发生在语音模式装配层**(见 `voice-mode-wiring` 的「装配层 EchoGuard 去抖默认」requirement),装配层据真机标定把 `confirmFrames` 覆盖为去抖值后再注入 VoiceLoop;库默认与装配默认的分工 MUST 各司其职、互不耦合。

#### Scenario: 禁用即时确认

- **WHEN** `enabled:false` 喂任意帧
- **THEN** `confirmed` 恒为真(等价无去抖,逐字现状)

#### Scenario: N=1 首帧即确认

- **WHEN** `confirmFrames:1`、喂一个 `prob ≥ minSpeechProb` 且 `speakingFromVad` 的帧
- **THEN** 该帧即 `confirmed:true`(与既有「检出语音即打断」时序一致)

#### Scenario: 库默认 confirmFrames 为 1(回归硬线)

- **WHEN** 读取 `DEFAULT_ECHO_GUARD_CONFIG`
- **THEN** `confirmFrames` 为 `1` 且 `enabled` 为 `false`(直接注入时逐字现状;去抖提升由装配层覆盖,不在库默认)

#### Scenario: N=3 需连续三帧

- **WHEN** `confirmFrames:3`,喂连续 3 帧高置信语音
- **THEN** 第 3 帧 `confirmed:true`;若其中插入一个低置信/静音帧 → 计数清零,需重新连续 3 帧才确认

#### Scenario: 能量阈值过滤低能量回声

- **WHEN** `minEnergy > 0`,某帧 `prob` 达标但 `energy01 < minEnergy`
- **THEN** 该帧不计入连续帧,`run` 清零(典型回声经空气衰减能量偏低,被滤除)
