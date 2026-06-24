## Why

`packages/autonomy` 的框架已相当完整(`SkillScheduler` + `BaseSkill` 四钩子 + `Arbiter`/requestSpeak + 单消费者优先级队列 + no-action 预算 + open-thread/idle-arc 技能),但**尚未与 runtime 接线**:
- **决策 LLM(silent|speak|idle)未实装**——技能"想说"缺少 §7 的 `tick→gather context→决策 LLM→persona guardrail→speak` 判断核心,目前不会真正主动开口。
- **用户语音 URGENT 优先级未进 VoiceLoop**——§7"软反转"(用户开口立即抢占一切、触发 abort、`attention_mode` companion/balanced/focus)无运行时调度。
- **帧管线 B 层处理器稀疏**(§4.2):`SentenceAggregator` / `ClassifierProcessor`(3 层过滤:剥工具调用/表情标签/舞台指示 → 显示文本 / 口语文本→TTS / 情绪标签→人格)未完整接入,VoiceLoop 直接凑句,缺结构化过滤。

本变更把这三处接线起来,让 §7 行为层(主动性、会反对的表达通道、用户优先)真正"活"起来,并补齐 §4.2 帧管线过滤。**autonomy 默认仍可关**(承设计 P4 默认关),接线后通过配置启用。

## What Changes

- **决策 LLM 接入 SkillScheduler**(§7):技能产出候选 → 决策 LLM 返回 `silent|speak|idle`(多数 silent,给模型显式"沉默"工具)+ persona guardrail → 经 `Arbiter.requestSpeak` 仲裁;决策可追溯(§8.1 记录 silent/speak 理由)。
- **用户语音 URGENT 优先级进 VoiceLoop**(§7 软反转):用户开口立即抢占在飞的 autonomy/外部动作,触发 abort 三件套;`interaction_dials.attention_mode`(companion/balanced/focus)调三个量(队列等级 / 是否打断 / 真打断门槛);不可配底线(永远感知、危机覆盖、硬打断通道)。
- **帧管线处理器**(§4.2):`SentenceAggregator`(token→句级)+ `ClassifierProcessor`(3 层过滤分流显示/口语/情绪)接进 B 层帧管线 / VoiceLoop 消费路径。
- **autonomy↔runtime 事件契约**:autonomy 经 A 层总线接收 `signal:*`(来自感知/计时)、经 `requestSpeak` 出声;与 VoiceLoop 的"忙闲(is_speaking)硬闸"对接。

## Capabilities

### New Capabilities
- `proactive-turn`: 主动回合的决策与调度——决策 LLM(silent|speak|idle)+ requestSpeak 仲裁接入 + 用户语音 URGENT 优先级 + attention_mode + 决策可追溯。
- `frame-processing`: 帧管线 B 层处理器 SentenceAggregator + ClassifierProcessor(3 层过滤分流)。

### Modified Capabilities
<!-- VoiceLoop 既有"听→想→说"行为在 autonomy 关闭时逐字不变;无既有 spec REQUIREMENT 破坏性变更。 -->

## Impact

- **改动**:`packages/runtime`(voice-loop / conversation / frame-processor:接 URGENT 抢占、帧处理器)、`packages/autonomy`(决策 LLM、scheduler↔arbiter↔runtime 接线)。
- **依赖**:决策 LLM 复用 `providers` 的 `LlmProvider`(测试用 `FakeLlm`),不引新依赖。
- **不动**:`memory`/`persona`/`interaction`/`gateway`(经接缝/总线解耦)。
- **降级/默认**:autonomy **默认关**(承 P4),关闭时 VoiceLoop 行为逐字不变;决策 LLM 失败 → 退回 silent(永不刷屏、永不崩,§3.2)。
- **并行安全**:这是四个并行 change 中**唯一改 `runtime`** 的(已把帧处理器并入此 change,避免与他者在 runtime 冲突);与 gateway(新包)、interaction、memory 各自包无重叠。
