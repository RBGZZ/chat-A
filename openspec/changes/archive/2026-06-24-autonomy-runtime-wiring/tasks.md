## 1. 决策 LLM(silent|speak|idle)

- [x] 1.1 决策 LLM 接口:输入 = 技能候选 + gather context(情绪/未了话题/时间);schema 约束输出 `{decision:silent|speak|idle, reason, text?}`(复用 providers `LlmProvider`)
- [x] 1.2 接入 `SkillScheduler`:tick→gather→决策 LLM→persona guardrail→`Arbiter.requestSpeak`(经 `ProactiveTurnRunner` 串接;技能 tick 调 runner)
- [x] 1.3 给模型显式"沉默"选项 + 衰减概率 governor(base rate 由 PAD/OCEAN 调制 → affectBias)
- [x] 1.4 失败/超时 → 默认 silent(不刷屏不崩);决策 + reason 落 SQLite 决策 trace(§8.1,经 `AutonomyDecisionSink` 接缝,接线层提供 SQLite 实现)

## 2. 用户语音 URGENT 优先级进 VoiceLoop(§7 软反转)

- [x] 2.1 在 VoiceLoop 打断路径加"用户语音事件优先级闸"(可选注入);用户开口抢占在飞 autonomy/动作 → 触发 abort 三件套(复用现有 AbortController + generation)
- [x] 2.2 `interaction_dials.attention_mode`(companion/balanced/focus)调三个量:队列等级 / 是否触发 abort / 真打断门槛(focus 要求更长坚持/关键词)
- [x] 2.3 不可配底线:永远感知用户语音、危机覆盖、硬打断通道(任何模式)
- [x] 2.4 外部动作默认压低优先级,绝不 critical 抢占用户语音;被打断半句写回记忆(标 interrupted,复用既有半句写回)

## 3. 帧管线处理器(§4.2)

- [x] 3.1 `SentenceAggregator`(token→句)接入 VoiceLoop "说"路径(等价封装 SentenceSplitter,既有测试保持绿)
- [x] 3.2 `ClassifierProcessor`(纯函数)3 层过滤:剥工具调用/表情标签/舞台指示 → `{displayText, spokenText, emotionTags}` 分流(口语→TTS、情绪→人格、显示→记录)

## 4. autonomy↔runtime 接线(经总线 + requestSpeak)

- [x] 4.1 autonomy 订阅 A 层总线 `signal:*`(来自感知/计时;interaction change 未合并时用占位类型 + 适配,经 `signal-adapter`)
- [x] 4.2 出声经 `Arbiter.requestSpeak` 查 VoiceLoop is_speaking 硬闸;不直接 import VoiceLoop 内部(requestSpeak 注入闭包)
- [x] 4.3 `CHAT_A_AUTONOMY=on|off`(缺省 off);off 时不挂调度(`isAutonomyEnabled`)

## 5. 测试

- [x] 5.1 决策 LLM 用 FakeLlm:silent/speak/idle 三分支;失败退 silent;决策落 trace
- [x] 5.2 URGENT 抢占:用户开口→在飞 autonomy 被 abort + 半句写回;attention_mode 三档行为;危机/硬打断不可配
- [x] 5.3 SentenceAggregator:token→句;ClassifierProcessor golden test(剥标签 + 分流)
- [x] 5.4 **回归(硬线)**:autonomy=off 时 VoiceLoop 既有测试全绿、行为逐字不变

## 6. 收尾

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 6.2 worktree 根 `npx vitest run` 全绿(新增 + 回归,尤其 runtime 既有用例)
- [x] 6.3 自检:§7 决策/URGENT 软反转/不可配底线、§4.2 帧过滤、§3.1 经总线解耦、§8.1 决策可追溯、默认关回归;commit 到 worktree 分支(中文),不 push、不动 master
- [x] 6.4 简报注明:per_capability 热切为接缝预留;signal 事件契约与 external-interaction-mvp 的对齐点(合并取并集)
