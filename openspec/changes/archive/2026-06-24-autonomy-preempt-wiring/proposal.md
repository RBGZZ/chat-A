## Why

`autonomy-runtime-wiring` / `runtime-assembly-wiring` 已把 autonomy 引擎挂上调度并经总线消费 `signal:*`、经 `requestSpeak` 仲裁出声、决策落 SQLite trace。但 MVP 为控制爆炸半径**刻意留了三处接缝**(见各文件注释「MVP 仅记录 / 保守缺省 / 占位」),导致 autonomy 在 on 路径下其实**说不出口、判不准忙闲、候选是占位**:

1. **`shouldPreempt` 没真接 VoiceLoop 打断**(`packages/client/src/assembly/autonomy.ts` `AutonomyRunnerSkill.tick` + `onPreempt`):`ProactiveTurnRunner` 产出的 `shouldPreempt` 只回调记录,没有一条干净路径触发 VoiceLoop 已有的 abort 三件套(`#gen++` + `abort()` + `clearBuffer` + 半句写回)。
2. **`is_speaking` 是保守缺省**(`assembleAutonomy` 的 `readState` 缺省 `{isSpeaking:false}`):arbiter 永远以为「不在说」,抢占判定失真。要让仲裁查到 VoiceLoop 的**真实说话状态**,但**不得 import VoiceLoop 内部**(§3.1),须经只读接口 / 回调。
3. **候选是 signal 描述占位**(`AutonomyRunnerSkill.tick` 用 `event.payload.description` 当候选):既有 `OpenThreadFollowUpSkill` / `IdleEmotionArcSkill` 能从「记忆未了话题 / 情绪弧」产出**真实候选**,却未喂进决策回路。

本变更**只填这三处缝**,复用既有打断核心 / 仲裁纯函数 / 技能,不重写。承 §7(行为层:用户语音 URGENT 永远最高,autonomy 自身抢占受 `attention_mode` + `is_speaking` 约束)、§4(打断在 runtime 执行)、§3.1(依赖倒置,跨模块只经接口)。

## What Changes

- **VoiceLoop 暴露两处只读/触发接缝(runtime,纯加法)**:
  - 只读 `isSpeaking` getter + `speakState()`(返回 `{isSpeaking, speakingPriority?}`),供 arbiter 经回调查真实忙闲——**不导出内部状态机**。
  - `requestAutonomyPreempt(reason)` 触发钩子:autonomy 判定抢占时经此进入**已有**打断路径(复用 `#interrupt`/abort 三件套),但**受 §7 约束**——仅当当前 `isSpeaking` 且(注入的)attention 允许时才真打断;**绝不凌驾用户语音 URGENT**(用户开口的 barge-in 路径不变,优先级恒最高)。
- **autonomy 真候选生成接缝(autonomy)**:`AutonomyRunnerSkill` 接受可选 `candidateSource`,优先从注入的 open-thread / idle-arc 候选源取真实候选(基于记忆未了话题 / 情绪弧);无源或源空时回落到现状(signal 描述)。决策 LLM schema 约束 + 失败退 silent + 落 trace 全不变。
- **装配把三处缝接通(仅 `packages/client/src/assembly/autonomy.ts`)**:`assembleAutonomy` 新增可选注入 `voiceState`(读真忙闲)、`preempt`(触发真打断)、`candidateSource`(真候选);`onPreempt` 缺省回落到 `preempt`。**全部可选**:不注入即现状行为(off 路径与未接缝时逐字一致)。

## Non-goals

- 不重写 VoiceLoop 打断核心 / 状态机 / 仲裁纯函数。
- 不在本 change 改 `cli.ts` / `cli-voice.ts` / `voice-runner.ts`(client 其余文件另一并行 agent 拥有);本 change 只提供**可被装配的接缝** + 在唯一允许的 `assembly/autonomy.ts` 接通。最终把 VoiceLoop 实例喂给 `assembleAutonomy` 的 cli 级胶水,留给拥有 cli 的一方按本接缝接(报告中标注)。
- 不动 voice-detect / providers / memory / gateway。

## 延迟预算影响(§3.2)

零热路径影响:`isSpeaking` 为同步只读;`requestAutonomyPreempt` 走既有打断路径;候选生成在 autonomy 低频 tick(非用户首字延迟链路)。off 路径不构造任何新对象。

## Impact

- **改动**:`packages/runtime`(voice-loop 暴露 `isSpeaking`/`speakState`/`requestAutonomyPreempt`,纯加法)、`packages/autonomy`(`AutonomyRunnerSkill` 候选源接缝 —— 注:该类实体在 client assembly,本 change 在 autonomy 增**候选源接口 + 适配**,在 assembly 接线)、`packages/client/src/assembly/autonomy.ts`(接通三缝)。
- **依赖**:不引新依赖(复用既有 attention / arbitrate / 技能)。
- **不动**:voice-detect / providers / memory / gateway;protocol 仅在确需时追加(预计无需)。
- **降级/默认**:`CHAT_A_AUTONOMY=off`(缺省)→ `assembleAutonomy` 返回 undefined,三缝全不构造;on 路径不注入新端口时退回现状(保守缺省 / 占位候选 / 仅记录),与本 change 前逐字一致。
- **不可配底线**:用户语音 URGENT 优先 + 危机覆盖 + 硬打断通道不受 autonomy 抢占影响(§7);autonomy 抢占只在 `isSpeaking` 且 attention 允许时触发,且永远让位用户。
- **并行安全**:runtime 仅纯加法新成员;autonomy 仅新接口 + 可选参数;client 仅动 `assembly/autonomy.ts` 一个文件(供合并协调)。
