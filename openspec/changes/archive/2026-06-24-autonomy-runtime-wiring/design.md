## Context

`packages/autonomy` 已有:`SkillScheduler`(单循环 reconcile 多技能、enabled 现读 config、per-skill inflight 锁、异常隔离)、`BaseSkill`(initialize/start/tick/stop/onConfigReload)、`Arbiter`(requestSpeak,单 is_speaking 硬闸 + 优先级抢占 + resumeBuffer)、`PriorityQueue`(单消费者优先级)、`Budget`(no-action 预算)、`open-thread-skill` / `idle-emotion-arc-skill`(技能实例)。

`packages/runtime` 已有:`VoiceLoop`(四态机 + generation 自检 + AbortController 真打断)、`Conversation`(回合编排,SingleShot)、`tool-calling-strategy`、`frame-processor`(双队列骨架 + InterruptionFrame)、`bus`(LightVoiceBus)。

缺口:三处接线未做(决策 LLM、URGENT 优先级、帧处理器)。设计要点:§7 `tick→gather context→决策 LLM(silent|speak|idle,多数 silent)→persona guardrail→speak`;§7 用户语音永远 URGENT(软反转)但 `attention_mode` 可配;§4.2 ClassifierProcessor 3 层过滤 + SentenceAggregator。

## Goals / Non-Goals

**Goals:**
- 决策 LLM:技能候选 → `LlmProvider` schema 约束输出 `{decision: silent|speak|idle, reason}`(给模型显式"沉默"选项)→ persona guardrail → `Arbiter.requestSpeak`;决策(含 reason)落 §8.1 可追溯。
- 用户语音 URGENT 抢占进 VoiceLoop:用户开口 → 抢占在飞 autonomy/动作 + 触发 abort 三件套(承现有 AbortController);`attention_mode` 调度旋钮(companion/balanced/focus)。
- 帧处理器:`SentenceAggregator`(token→句)+ `ClassifierProcessor`(剥工具调用/表情标签/舞台指示 → 显示文本 / 口语文本→TTS / 情绪标签→人格)接进 VoiceLoop "说"路径。
- autonomy 默认关:关闭时 VoiceLoop 行为逐字不变(回归保证)。
- 全部可测:决策 LLM 用 `FakeLlm`、确定性驱动;URGENT 抢占、帧处理器纯函数过滤写 golden test。

**Non-Goals:**
- 感知源 `signal:*` 的产生(由 external-interaction-mvp 负责;本 change 只消费总线 signal)。
- Neuro 专有 force/priority 解冻(§3.3 🅽)。
- 完整 Pipecat FrameProcessor 图重构——只补 SentenceAggregator/ClassifierProcessor 两个关键处理器,接入现有 VoiceLoop,不推翻 VoiceLoop。
- 直播/游戏的 attention_mode per_capability 热切(留接缝,MVP 只做全局 attention_mode)。

## Decisions

1. **决策 LLM = schema 约束的确定性边界调用**(§3.2 把 LLM 关进笼子):输入 = 技能候选 + gather 的 context(情绪/未了话题/时间);输出 schema `{decision, reason, text?}`;失败/超时 → 默认 `silent`(永不刷屏)。复用 `providers` 的 `LlmProvider`,测试 `FakeLlm`。
2. **不重写 VoiceLoop,只接 URGENT 钩子**:在 VoiceLoop 现有打断路径上加"用户语音事件优先级闸"——`attention_mode` 决定:用户语音事件队列等级 / 是否触发 abort 三件套 / "判定真打断"门槛(focus=要求更长坚持/关键词)。游戏等外部动作默认压低,绝不 critical 抢占用户语音。底线不可配:永远感知、危机覆盖、硬打断通道(§7)。
3. **帧处理器作为 VoiceLoop "说"路径的可插拔阶段**:`SentenceAggregator` 替/补现有 SentenceSplitter(token→句);`ClassifierProcessor` 纯函数 3 层过滤,产出 `{displayText, spokenText, emotionTags}` 分流(口语→TTS、情绪→人格、显示→记录)。纯函数 → golden test。
4. **autonomy↔runtime 经总线 + requestSpeak 解耦**(§3.1):autonomy 订阅 `signal:*`、出声走 `Arbiter.requestSpeak`(查 VoiceLoop is_speaking 硬闸);不直接 import VoiceLoop 内部。
5. **默认关 + 行为即配置**:`CHAT_A_AUTONOMY=on|off`(缺省 off);off 时不挂调度、VoiceLoop 逐字不变(回归用例锚定)。
6. **可追溯**(§8.1):每次 tick 的 silent/speak/idle 决策 + 输入 + reason 落 SQLite 决策 trace(autonomy 决策可追溯)。

## Risks / Trade-offs

- **改 runtime 的回归风险**:VoiceLoop 是核心;以"autonomy 关闭时逐字不变"为硬回归线,帧处理器作为可选阶段(不破坏既有 SentenceSplitter 路径或等价替换并跑通既有测试)。
- **决策 LLM 延迟/成本**:主动决策不在用户首字热路径(autonomy 是后台 loop);仍加超时 + 预算节流(no-action 预算已有),失败退 silent。
- **URGENT 与 abort 三件套耦合**:抢占须复用现有 AbortController + generation,避免新旧状态交叠;以测试覆盖"用户开口→在飞 autonomy 被 abort、半句写回"。
- **attention_mode 范围**:MVP 仅全局模式;per_capability 热切留接缝(与 external-interaction 的能力上下文对接,后续)。
- **与 external-interaction-mvp 的边界**:本 change 消费 `signal:*`、产 `requestSpeak`;signal 事件 schema 由 interaction change 定义——两者经 `protocol` 事件契约对齐,若 interaction 尚未合并,本 change 用占位 signal 类型 + 适配(合并时取并集)。
