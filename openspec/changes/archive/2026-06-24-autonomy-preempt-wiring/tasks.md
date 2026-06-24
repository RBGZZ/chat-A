# Tasks: autonomy-preempt-wiring

## 1. 缝 2 + 缝 1:VoiceLoop 暴露 is_speaking 只读 + autonomy 抢占触发钩子(runtime,纯加法)

- [x] 1.1 在 `packages/runtime/src/voice-loop.ts` 加只读 `get isSpeaking(): boolean`(= `#state === 'speaking'`)。
- [x] 1.2 加 `speakState(): SpeakStateView` 返回 `{ isSpeaking, speakingPriority? }`(结构等价 autonomy `SpeakState`,MVP 省略 priority);定义并导出 `SpeakStateView` 类型(runtime 侧,避免反向依赖 autonomy)。
- [x] 1.3 加 `requestAutonomyPreempt(reason?: string): boolean`:非 speaking → false 无副作用;speaking 且无 attention → 复用 `#interrupt(reason)` 返回 true;speaking 且有 attention → 经 `evaluateAttention(mode, {sustainedMs:0, somethingInFlight:true})` 判 `trueInterrupt` 才打断。
- [x] 1.4 让 `#interrupt` 接受可选 `reason`(透传 `turn:interrupt` 的 reason,默认 `barge_in` 保持现状);用户 barge-in 路径仍传默认,autonomy 抢占传 `autonomy_preempt`。**不改打断核心逻辑**。
- [x] 1.5 `packages/runtime/test/voice-loop-preempt.test.ts`:speaking 中 `requestAutonomyPreempt` → listening + `turn:interrupt(autonomy_preempt)` + 半句写回;非 speaking → false 无副作用;`isSpeaking`/`speakState()` 各态断言;focus attention 不打断 / companion 打断。

## 2. 缝 3:autonomy 真候选源(autonomy)

- [x] 2.1 在 `packages/autonomy/src` 新增 `candidate-source.ts`:`ProactiveCandidateSource` 接口 + `openThreadCandidateSource(port, clock, options?)`(复用 `renderFollowUpText` + judge/score 挑最值得一条)+ `idleArcCandidateSource(presence, clock, emotion?, options?)`(复用 `renderArcText` + idle 判定)+ `combinedCandidateSource([...])`(合并去空)。standalone,不依赖 memory。
- [x] 2.2 `index.ts` 导出 candidate-source。
- [x] 2.3 `packages/autonomy/test/candidate-source.test.ts`:FakeOpenThreadPort 有值/无值 → 候选/空;FakePresence idle 超阈值 → 想念候选;combined 合并去空。

## 3. 缝 1+2+3 接通(仅 `packages/client/src/assembly/autonomy.ts`)

- [x] 3.1 `AutonomyRunnerSkill` 增可选 `candidateSource`:tick 时优先 `await gather({signalKind, description})`,非空用真候选,空/无源回落现状占位。
- [x] 3.2 `AssembleAutonomyDeps` 增可选 `voiceState?: () => SpeakStateView`(→ `currentSpeakState` 等价接入)、`preempt?: (reason?: string) => void`、`candidateSource?: ProactiveCandidateSource`。`currentSpeakState` 优先 `voiceState`;`onPreempt` 缺省回落 `() => preempt?.('autonomy_preempt')`;`candidateSource` 透传给技能。
- [x] 3.3 `packages/client/test/assembly-autonomy-preempt.test.ts`:注入 fake voiceState(isSpeaking=true)+ fake preempt + fake candidateSource → 总线 signal 驱动一次决策用真候选 + shouldPreempt 时调 preempt;off / 未注入仍回落现状(沿用既有断言)。

## 4. off 回归 + 全绿验收

- [x] 4.1 `pnpm -r typecheck` 全绿。
- [x] 4.2 `npx vitest run`(runtime + autonomy + client)全绿,**含既有 voice-loop / autonomy / assembly-autonomy off 回归**。
- [x] 4.3 `npx openspec validate autonomy-preempt-wiring --strict` 通过。
