## ADDED Requirements

### Requirement: autonomy 抢占经干净触发入口接入 VoiceLoop 真打断

系统 SHALL 提供一条从「autonomy 判定该抢占」到 VoiceLoop **既有** abort 三件套(generation 作废 + abort 底层 LLM 流 + clearBuffer + 半句写回)的干净触发路径,而非仅记录信号。VoiceLoop MUST 暴露一个触发钩子(如 `requestAutonomyPreempt`),复用既有 `#interrupt` 打断核心、**不重写**之。该 autonomy 自身抢占 MUST 受 §7 约束:仅当 VoiceLoop 当前 `isSpeaking` 且(注入的)`attention_mode` 允许时才真打断;无在飞输出(非 speaking)时 MUST NOT 打断。该路径 MUST NOT 凌驾用户语音 URGENT —— 用户开口的 barge-in 路径独立且恒为最高优先,不经此钩子、不与之竞争。

#### Scenario: autonomy 抢占在 speaking 中触发真打断

- **WHEN** VoiceLoop 处于 speaking(有在飞 autonomy/动作输出),且未注入或 companion attention,调用 `requestAutonomyPreempt('autonomy_preempt')`
- **THEN** 进入既有打断路径(回 listening、emit `turn:interrupt`、被打断半句写回记忆),返回 true

#### Scenario: 非 speaking 时 autonomy 抢占无副作用

- **WHEN** VoiceLoop 处于 listening / thinking(无在飞 autonomy 输出),调用 `requestAutonomyPreempt`
- **THEN** 不触发打断、不改状态、不写回,返回 false

#### Scenario: attention_mode 约束 autonomy 自身抢占

- **WHEN** 注入 `attention_mode=focus`,VoiceLoop speaking 中以「短暂/无坚持」信号触发 `requestAutonomyPreempt`
- **THEN** 经 `evaluateAttention` 判定 `trueInterrupt=false` → 不打断,保持 speaking(autonomy 不轻易打断自己的专注输出);companion 模式同条件则打断

#### Scenario: 用户语音 URGENT 不受 autonomy 抢占影响

- **WHEN** 用户在 VoiceLoop speaking 中开口(barge-in)
- **THEN** 走既有用户语音打断路径(恒最高优先、立即/按 attention 判),与 autonomy 抢占钩子完全独立,autonomy 抢占绝不凌驾之

### Requirement: arbiter 经只读接口查 VoiceLoop 真实 is_speaking

系统 SHALL 让 `Arbiter.requestSpeak` 的忙闲判定来自 VoiceLoop 的**真实说话状态**,而非保守缺省 `{isSpeaking:false}`。VoiceLoop MUST 暴露只读 `isSpeaking` 与 `speakState()`(返回 `{isSpeaking, speakingPriority?}` 结构),装配层 MUST 经回调/接口读取并接入 arbiter 闭包,MUST NOT 直接 import VoiceLoop 内部状态机(§3.1)。

#### Scenario: 真在说时高优先抢占、低优先让位

- **WHEN** VoiceLoop `isSpeaking=true`,arbiter 闭包经 `speakState()` 读到真状态,来者优先级严格更高
- **THEN** `arbitrate` 裁决 `speak` 且 `preempted=true`;来者优先级不更高且可延续 → `defer`;不可延续 → `drop`

#### Scenario: 真空闲时直接放行

- **WHEN** VoiceLoop `isSpeaking=false`,arbiter 经 `speakState()` 读真状态
- **THEN** `arbitrate` 裁决 `speak`、不抢占

### Requirement: autonomy 候选来自真实技能产出而非 signal 占位

系统 SHALL 让主动回合的候选发言由既有技能(open-thread 未了话题 / idle-emotion-arc 情绪弧)基于记忆/在场感产出真实候选,而非以 signal 描述当占位喂决策 LLM。autonomy MUST 提供候选源接口(`ProactiveCandidateSource`)+ 复用既有 `renderFollowUpText`/`renderArcText` 的适配器;`AutonomyRunnerSkill` MUST 优先用注入候选源产出的非空候选,无源/源空时回落现状占位。决策 LLM 的 schema 约束、概率闸、失败退 silent、落 trace MUST 全部不变(候选只是喂料,restraint-first 不被削弱)。

#### Scenario: open-thread 真候选喂决策

- **WHEN** 注入基于 `OpenThreadPort` 的候选源,存在一条值得跟进的未了话题,autonomy tick 触发
- **THEN** 候选为 `renderFollowUpText` 渲染的真实跟进语(非 signal 描述),喂决策 LLM 后照常裁决/落 trace

#### Scenario: 候选源为空回落现状

- **WHEN** 未注入候选源,或注入的候选源本 tick 返回空数组
- **THEN** `AutonomyRunnerSkill` 回落到现状占位候选(signal 描述 / kind),行为与本变更前一致

#### Scenario: 候选多不削弱克制

- **WHEN** 候选源产出多条真实候选
- **THEN** 决策 LLM 的概率闸 + schema 仍照常裁决,多数 tick 仍可沉默(restraint-first 不被候选数量影响)

### Requirement: 三处接缝默认关且关闭/未注入时行为不变

三处接缝填补 SHALL 默认关闭:`CHAT_A_AUTONOMY=off`(缺省)时 `assembleAutonomy` 返回 undefined,三缝(preempt 触发 / 真 is_speaking 读取 / 真候选源)MUST NOT 构造。on 路径下未注入对应端口时 MUST 回落到现状(保守缺省 / 占位候选 / 仅记录),与本变更前逐字一致。VoiceLoop 新增成员 MUST 为纯加法只读/方法,MUST NOT 改动既有状态迁移与用户 barge-in 路径。

#### Scenario: off 回归

- **WHEN** 未启用 autonomy(`CHAT_A_AUTONOMY` 缺省/非 on)
- **THEN** 既有 runtime / autonomy / client 测试全部通过,VoiceLoop 与总线行为逐字不变

#### Scenario: on 但未注入新端口回落现状

- **WHEN** `CHAT_A_AUTONOMY=on` 但未注入 preempt/voiceState/candidateSource
- **THEN** is_speaking 用保守缺省、候选用占位、抢占仅记录,与本变更前 on 路径逐字一致
