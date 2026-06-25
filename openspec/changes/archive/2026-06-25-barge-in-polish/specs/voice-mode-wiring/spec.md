## ADDED Requirements

### Requirement: 装配层 EchoGuard 去抖默认(语音模式默认开 + 真去抖)

语音模式装配 SHALL 提供 `loadEchoGuardConfig(env)`,据 `CHAT_A_ECHO_GUARD` 决定是否注入 EchoGuard 配置到 VoiceLoop:

- `CHAT_A_ECHO_GUARD` 取 `off` / `false` / `0` / `no` / `disabled`(大小写不敏感、去空白)时 MUST 返回 `undefined`(VoiceLoop 不注入 EchoGuard → barge-in 逐字现状即时打断,回归硬线、优雅降级 §3.2)。
- 其余值 / 缺省时 MUST 返回 `enabled:true` 的配置(语音模式**默认开启**自打断防护)。

返回的配置 MUST 把 `confirmFrames` 设为**去抖值 `3`**(≈30ms,10ms/帧)而非沿用库默认 `1`:需连续 3 帧高置信语音才确认是用户真说话→才打断,压制自家 TTS 经空气/回环灌进麦克风的单帧回声尖峰与瞬态噪声误打断(§4 自打断防护软件侧缓解真正生效)。其余阈值沿用 `DEFAULT_ECHO_GUARD_CONFIG`(`minSpeechProb`/`minEnergy`/`cooldownMs`/双层 RMS 门槛)。3 帧 ≈30ms 远低于人类反应/感知阈,伴侣仍「能被打断」(不变迟钝);此值即「最短连续语音时长门槛」,无需再叠独立的 min-interruption 时长护栏(职责等价、避免重复工程)。

本切片 MUST NOT 新增 `confirmFrames` 专属 env 旋钮(避免过度工程);`CHAT_A_ECHO_GUARD` 开关语义保持不变。

#### Scenario: 缺省 → 默认开且去抖值为 3

- **WHEN** `env` 不含 `CHAT_A_ECHO_GUARD`
- **THEN** `loadEchoGuardConfig(env)` 返回 `enabled:true` 且 `confirmFrames:3`(默认开启自打断防护、真去抖)

#### Scenario: 显式关闭 → 不注入(回落现状)

- **WHEN** `CHAT_A_ECHO_GUARD` 为 `off`(或 `false`/`0`/`no`/`disabled`)
- **THEN** `loadEchoGuardConfig(env)` 返回 `undefined`(VoiceLoop 不注入 EchoGuard,barge-in 逐字现状即时打断)

#### Scenario: 其它非关闭值 → 仍默认开且去抖

- **WHEN** `CHAT_A_ECHO_GUARD` 为 `on`(或任意非关闭值)
- **THEN** `loadEchoGuardConfig(env)` 返回 `enabled:true` 且 `confirmFrames:3`

#### Scenario: cli 与 desktop 共用装配路径同得去抖默认

- **WHEN** cli 语音入口或 desktop `voiceStart` 经共用的 `startVoiceMode(deps)`(传 `env`)启动语音
- **THEN** 二者均经同一 `loadEchoGuardConfig(env)` 注入 EchoGuard;缺省下 desktop 与 cli 同样得到 `enabled:true`/`confirmFrames:3` 的去抖默认(desktop 不存在「漏注入 EchoGuard」缺口)
