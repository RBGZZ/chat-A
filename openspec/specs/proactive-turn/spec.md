# proactive-turn Specification

## Purpose
TBD - created by archiving change autonomy-runtime-wiring. Update Purpose after archive.
## Requirements
### Requirement: 决策 LLM(silent|speak|idle)接入 SkillScheduler

系统 SHALL 在 SkillScheduler 的技能候选产出后,经决策 LLM 以 schema 约束输出 `{decision ∈ {silent,speak,idle}, reason, text?}`(默认偏向 silent、给模型显式"沉默"选项),通过 persona guardrail 后由 `Arbiter.requestSpeak` 仲裁出声。

#### Scenario: 多数情况选择沉默
- **WHEN** 技能产生一个低价值候选且无足够动机
- **THEN** 决策 LLM 返回 `silent`,系统不出声

#### Scenario: 决策 LLM 失败退回沉默
- **WHEN** 决策 LLM 调用超时或报错
- **THEN** 系统默认 `silent`,不刷屏、不崩溃(§3.2)

#### Scenario: 决策可追溯
- **WHEN** 一次 tick 产生 silent/speak/idle 决策
- **THEN** 该决策及其输入与 reason 落 SQLite 决策 trace(§8.1)

### Requirement: 用户语音 URGENT 优先级抢占

系统 SHALL 令用户语音在回合调度中默认 URGENT——用户开口立即抢占在飞的 autonomy 输出与外部动作并触发 abort 三件套;`interaction_dials.attention_mode`(companion/balanced/focus)SHALL 调节抢占行为,但永远感知/危机覆盖/硬打断通道为不可配底线。

#### Scenario: 用户开口抢占主动输出
- **WHEN** autonomy 正在说话或外部动作在飞,用户开口
- **THEN** (companion 默认)立即触发 abort 三件套中断在飞输出,优先处理用户;被打断的半句写回记忆(标 interrupted)

#### Scenario: attention_mode=focus 提高打断门槛
- **WHEN** `attention_mode=focus` 且用户短暂出声
- **THEN** 系统仍感知用户语音,但需更长坚持/关键词/危机才中断当前专注(绝不"装聋")

#### Scenario: 危机与硬打断不可配
- **WHEN** 出现危机信号或用户使用硬打断("停一下/看着我")
- **THEN** 无视任何 attention_mode,立即最高优先处理

### Requirement: autonomy 默认关且关闭时行为不变

autonomy 接线 SHALL 默认关闭(`CHAT_A_AUTONOMY=off` 缺省);关闭时 VoiceLoop 的"听→想→说"行为与本变更前逐字一致。

#### Scenario: 默认关闭回归
- **WHEN** 未启用 autonomy
- **THEN** VoiceLoop 既有测试全部通过,行为逐字不变

