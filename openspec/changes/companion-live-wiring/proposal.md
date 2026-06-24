## Why

`runtime-assembly-wiring` 已把 autonomy 主动引擎「上线」(`assembleAutonomy` 挂调度、订阅总线、落 SQLite 决策 trace),但她仍只是**空转**:

- **没有真候选源**:`AutonomyRunnerSkill` 的 `candidateSource` 接缝已就位,但 cli.ts(文字)与语音两条装配处都没注入——主动回合只能用 signal 描述当占位,产不出「未了话题跟进 / idle 情绪弧」这类真实伴侣发言。
- **memory→autonomy 没有适配器**:autonomy 包 standalone 定义了 `OpenThreadPort` / `PresencePort`,memory 也有 `openThreads()` / 人物在场数据,但二者之间**缺一个装配层适配器**把记忆映射成真候选输入。
- **语音模式没接 is_speaking 真闸 / 抢占**:`B` 已在 `VoiceLoop` 暴露 `speakState()` / `requestAutonomyPreempt(reason)`,但语音模式(`cli-voice` / `voice-runner`)根本没装配 autonomy,更没把 `voiceState` / `preempt` 接缝接上——arbiter 查不到 VoiceLoop 真忙闲,抢占在语音里也不生效。
- **「填 key 即用」差一步**:`loadLlmConfig` 默认解析只认 `ANTHROPIC_API_KEY`;用户把 DashScope key 填进 `CHAT_A_DASHSCOPE_API_KEY` 仍默认回落 `fake`,必须再显式设 `CHAT_A_LLM_PROVIDER=qwen` + `CHAT_A_LLM_API_KEY` 才通——不够「填 key 即用」。

本 change 是**纯装配/接线层 + 一处默认解析**:把上述四点接成端到端真活,**不重写 runtime / autonomy / memory 内部**(autonomy/memory 只调既有公开 API;runtime 只读其已暴露 API)。

**硬线(回归绿是底线)**:所有新主动性接线在 `CHAT_A_AUTONOMY=on` 路径;**`CHAT_A_AUTONOMY=off`(缺省)时 MUST NOT 构造/注入任何候选源/适配器/voiceState/preempt,既有文字/语音/总线行为逐字不变**——既有全量测试全绿不可破。默认 provider 解析为纯加法分支,显式 `CHAT_A_LLM_PROVIDER` 行为完全不变。真硬件(麦克风/扬声器/真模型/真网络)**不在本 change 验证**,用 FakeLlm / 假 store / 假 VoiceLoop 状态写不触网单测。

## What Changes

- **「填 key 即用」默认 provider(纯加法分支,默认解析)**:`loadLlmConfig` 在 `CHAT_A_LLM_PROVIDER` **未显式设置**时,新增一档解析——若 `CHAT_A_DASHSCOPE_API_KEY` 存在(非空)→ 默认 `qwen`(model 默认 `qwen-plus`),并把 apiKey 回落到该 DashScope key;否则保持现有优先级(有 `ANTHROPIC_API_KEY` → `anthropic`,再 → `fake`)。显式设置 `CHAT_A_LLM_PROVIDER` / `CHAT_A_LLM_API_KEY` / `CHAT_A_LLM_MODEL` 时行为完全不变(纯加法,不破坏既有分支)。

- **memory→autonomy 端口适配器(装配层,默认关随 autonomy)**:在 `packages/client/src/assembly/` 新增适配器,用 `@chat-a/memory` 的公开 API 实现 autonomy 的 `OpenThreadPort`(基于 `store.openThreads()` 把 `MemoryRecord` 映射成 `OpenThread`:`id→String(id)`、`text→topic`、`personId`、`lastSeenAtMs→lastMentionedAtMs`;memory 无 `dueAtMs`/`personName` 故省略——纯加法可选位)与 `PresencePort`(memory 无直接「用户上次活跃」数据 → 实现成**最小可用**:由装配层维护一个进程内 `lastUserActiveAtMs` 时间戳,订阅总线用户语音/输入事件刷新它,无事件时回落构造时刻;`currentEpisodeId` 据 idle 切片轮转。带注释说明数据来源与最小实现取舍)。仅 autonomy on 时构造。

- **接 candidateSource(文字 + 语音两路,默认关随 autonomy)**:在 `cli.ts`(文字 REPL)与语音模式两处 autonomy 装配处,注入 `combinedCandidateSource([openThreadCandidateSource(openThreadAdapter, clock), idleArcCandidateSource(presenceAdapter, clock)])`,让她产**真实主动候选**(未了话题跟进 / idle 想念弧)喂决策 LLM。候选只是喂料——决策 LLM 仍是唯一「是否值得说」裁决(schema 约束 + 概率闸 + 失败退 silent + 落 trace,全不变);off 时不构造候选源。

- **语音模式接 voiceState / preempt(默认关随 autonomy)**:语音模式(拿到 `VoiceLoop` 实例处)装配 autonomy 并注入 `voiceState: () => loop.speakState()`(arbiter 查 VoiceLoop 真忙闲,而非保守缺省)+ `preempt: (r) => loop.requestAutonomyPreempt(r)`(shouldPreempt 经此触发真打断)。**沿用 §7 约束:用户语音 URGENT 永远最高,autonomy 抢占绝不凌驾用户**(约束已在 `VoiceLoop.requestAutonomyPreempt` 内,本装配只读取其已暴露 API,**不改 voice-loop**)。off 时不装配 autonomy、不注入。

## Non-goals

- **不重写 runtime / autonomy / memory / voice-detect / gateway 内部**:autonomy/memory 只调既有公开 API;runtime 只**读**其已暴露的 `speakState()` / `requestAutonomyPreempt()` / `isSpeaking`,绝不改 `voice-loop.ts`(另一并行 agent 在改它做 echo-guard)。
- **不重做 autonomy 决策回路 / 概率闸 / restraint-first**:候选源只换「喂料」,决策裁决逻辑逐字不变。
- **不做真硬件 / 真模型 / 真网络验证**:免提连续对话真机手测、真 DashScope 主动开口属真机待验证项,本 change 用 Fake/假状态写不触网单测。
- **不改默认行为**:autonomy off 缺省下所有新接线零构造;默认 provider 新分支仅在 `CHAT_A_LLM_PROVIDER` 未设 且 仅有 DashScope key 时生效。

## Capabilities

### New Capabilities
- `companion-live-wiring`:把伴侣主动性接成端到端真活——memory→autonomy 端口适配器(open-thread / presence)+ 文字与语音两路注入真候选源 + 语音模式接 VoiceLoop `voiceState`/`preempt` 真闸真抢占 + 「填 key 即用」默认 provider(仅 DashScope key 即默认 qwen)。**主动性接线全部默认关(随 `CHAT_A_AUTONOMY`),off 时逐字不变**;可测(FakeLlm/假 store/假 VoiceLoop 状态,不触网)、可降级(候选源/适配器失败被隔离,不拖垮决策回路与主对话)。

### Modified Capabilities
<!-- 不破坏任何既有 spec REQUIREMENT:本 change 为新增能力且主动性接线默认关;`runtime-assembly` 的 autonomy 上线 REQUIREMENT 仍成立(本 change 只在其 on 路径补注入真候选/真闸,off 路径逐字不变);`provider-tooling` 的 provider 解析为纯加法新增一档默认分支,显式设置行为不变。 -->

## Impact

- **影响 canonical 章节**:§7(伴侣主动性:未了话题跟进 / idle 情绪弧 / is_speaking 硬闸 + 抢占不凌驾用户)、§6/§5(memory 未了话题/在场数据驱动主动候选)、§3.1(只经类型化端口接缝接线,不 import 别模块内部;memory→autonomy 经适配器依赖倒置)、§3.2(行为即配置 + 优雅降级:候选源失败隔离回落、填 key 即用默认)。与权威设计一致。
- **代码**:`packages/providers/src/config.ts`(默认 provider 解析,纯加法分支)+ `packages/client/src/`(新增 memory→autonomy 适配器薄壳;`assembly/autonomy.ts` 装配处复用;`cli.ts` 文字路注入候选源;`cli-voice.ts` / `audio/voice-runner.ts` 语音路装配 autonomy + 注入 voiceState/preempt/候选源)。**不改** runtime/autonomy/memory/voice-detect/gateway 内部源码。
- **依赖**:复用各包既有导出(`@chat-a/autonomy` 的 `combinedCandidateSource`/`openThreadCandidateSource`/`idleArcCandidateSource`/端口类型;`@chat-a/memory` 的 `openThreads`;`@chat-a/runtime` 的 `speakState`/`requestAutonomyPreempt`);不引新依赖。
- **降级/默认**:主动性接线全部默认关(随 `CHAT_A_AUTONOMY`);候选源/适配器任一失败被隔离(`combinedCandidateSource` 已隔离单源抛错;`AutonomyRunnerSkill` 候选源失败回落占位),不拖垮决策回路与主对话(§3.2)。默认 provider 新分支仅在 `CHAT_A_LLM_PROVIDER` 未设 且 仅有 DashScope key 时改变默认(否则逐字不变)。
- **延迟预算**:接线均在热路径之外(autonomy tick 由调度低频推;候选源读 memory 是本地毫秒级、且只在主动 tick 内;voiceState 是一次同步读)。**对用户首字延迟零影响**;is_speaking 真闸 + 抢占不凌驾用户保证主动性不打断用户说话(§7)。
- **测试**:新增默认 provider 各分支单测、memory→autonomy 适配器单测、文字+语音两路注入接通单测、语音 voiceState/preempt 接通单测、off 回归单测(FakeLlm / 假 store / 假 VoiceLoop 状态,**不触网、不碰真硬件**);既有全量回归保持绿。
- **真机待验证(本 change 不验证)**:真 DashScope key「填 key 即用」端到端、真麦克风「免提连续对话」时 autonomy 在用户说话间隙真实开口跟进未了话题 / 表达想念、is_speaking 真闸下抢占不打断用户。
