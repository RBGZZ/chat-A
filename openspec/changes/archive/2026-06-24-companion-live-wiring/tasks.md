## 1. 「填 key 即用」默认 LLM provider(`packages/providers/src/config.ts`,纯加法)

- [x] 1.1 `loadLlmConfig`:`CHAT_A_LLM_PROVIDER` 未设时新增一档默认解析——`hasAnthropicKey ? 'anthropic' : hasDashscopeKey ? 'qwen' : 'fake'`(`hasDashscopeKey = 非空 CHAT_A_DASHSCOPE_API_KEY`);anthropic 保持最高优先(向后兼容,dashscope 仅改原本落 fake 的情形)
- [x] 1.2 model 默认:provider 解析为 `qwen` 时缺省 `qwen-plus`(对齐 registry);anthropic→`claude-opus-4-8`、fake→`fake-1` 不变
- [x] 1.3 apiKey 回落:`CHAT_A_LLM_API_KEY`(最高)→ 默认解析为 qwen 时回落 `CHAT_A_DASHSCOPE_API_KEY` → 否则回落 `ANTHROPIC_API_KEY`(原逻辑);显式 `CHAT_A_LLM_PROVIDER`/`CHAT_A_LLM_MODEL`/`CHAT_A_LLM_API_KEY` 行为逐字不变
- [x] 1.4 更新 `loadLlmConfig` 文档注释(列出新增 DashScope 默认分支与 key 来源)

## 2. memory → autonomy 端口适配器(新 `packages/client/src/assembly/memory-autonomy-ports.ts`)

- [x] 2.1 `createOpenThreadPort(store)` 实现 `OpenThreadPort`:`listOpenThreads()` 调 `store.openThreads(limit)`,映射 `MemoryRecord → OpenThread`(`id→String(id)`、`text→topic`、`personId`(缺省回落主用户 id 占位)、`lastSeenAtMs→lastMentionedAtMs`;省略 `dueAtMs`/`personName`);try 兜底失败返回 `[]`(§3.2)
- [x] 2.2 `createPresencePort({ clock })` 实现 `PresencePort`(最小可用,带注释说明 memory 无在场真相源):进程内 `lastUserActiveAtMs`(构造取「现在」)、`markActive()` 刷新、`currentEpisodeId()` 据上次活跃时刻轮转(同段空闲稳定);读不抛
- [x] 2.3 适配器只依赖 `@chat-a/memory` 公开类型(`MemoryStore`/`MemoryRecord`)+ `@chat-a/autonomy` 端口类型;**不 import 别模块内部**(§3.1)

## 3. 候选源装配工厂(复用于文字 + 语音)

- [x] 3.1 新增小工厂(放 `memory-autonomy-ports.ts` 或装配处):`createCompanionCandidateSource({ store, clock, presence })` → `combinedCandidateSource([openThreadCandidateSource(otPort, clock), idleArcCandidateSource(presence, clock)])`;仅 autonomy on 时调用(零开销)

## 4. 文字路接 candidateSource(`packages/client/src/cli.ts`)

- [x] 4.1 autonomy on 时构造 presence 适配器 + 候选源,传给 `assembleAutonomy(env, { bus, llm, decisionSink, candidateSource })`;off 时 `assembleAutonomy` 仍返回 undefined(候选源不构造)
- [x] 4.2 文字回合收到用户输入时调 `presence.markActive()`(刷新在场;最小侵入,仅 on 时有 presence 实例)
- [x] 4.3 确认 off 路径与本 change 前**逐字一致**(候选源/适配器为 on 路径内构造)

## 5. 语音路装配 autonomy + 注入 voiceState/preempt/候选源(`cli-voice.ts` / `audio/voice-runner.ts` / `cli.ts`)

- [x] 5.1 `VoiceModeDeps` 新增**可选**钩子 `assembleVoiceAutonomy?(loop, bus): { stop(): void } | undefined`(cli 在 autonomy on 时传入闭包,已闭包 env/llm/store/sink/候选源;off 时不传)
- [x] 5.2 `startVoiceMode`(inprocess 档):`runVoiceLoop` 得到 `handle.loop` 后,若有 `assembleVoiceAutonomy` 则回调装配,注入 `voiceState: () => handle.loop.speakState()` + `preempt: (r) => handle.loop.requestAutonomyPreempt(r)`,返回的 autonomy handle 纳入语音 `stop()` 收尾(幂等、失败吞)
- [x] 5.3 `cli.ts`:autonomy on 时构造 `assembleVoiceAutonomy` 闭包(内部调 `assembleAutonomy` 注入 candidateSource + voiceState + preempt)传入 `startVoiceMode`;off 时不传
- [x] 5.4 只**读** `VoiceLoop` 已暴露 `speakState()`/`requestAutonomyPreempt()`;**不改** `voice-loop.ts`/`runVoiceLoop` 内部;§7 用户 URGENT 最高 / 抢占不凌驾用户约束沿用 VoiceLoop 内既有实现
- [x] 5.5 websocket 档(终端无本地 loop):不装配 autonomy(大脑侧职责),逐字不变

## 6. 测试(Fake/假 store/假 VoiceLoop 状态,不触网、不碰真硬件)

- [x] 6.1 `loadLlmConfig` 默认 provider 分支:仅 dashscope→qwen+qwen-plus+key 回落 / 无任何 key→fake / 显式 provider 优先(anthropic+dashscope 同在→anthropic)/ anthropic 现有不变 / 显式 model+api key 覆盖
- [x] 6.2 memory→autonomy 适配器:假 store `openThreads` 返回若干记录 → 字段映射正确(id/topic/personId/lastMentionedAtMs;无 dueAtMs/personName);`openThreads` 抛错 → 返回 `[]`;presence 无事件回落构造时刻、markActive 刷新、episodeId 稳定/轮转
- [x] 6.3 文字路注入:`CHAT_A_AUTONOMY=on` + FakeLlm(speak)+ 假 store(含未了话题)+ 候选源 → 总线驱动主动 tick → 候选来自真候选源 → 决策落注入 sink(speak);候选源单源抛错被隔离;off → 不构造候选源/适配器
- [x] 6.4 语音路接通:假 VoiceLoop 状态(`speakState` 报 isSpeaking:true)注入 voiceState → arbiter 据真状态(说话时不直接放行);注入 preempt + shouldPreempt → preempt 被调用;off → 语音不装配 autonomy
- [x] 6.5 off 回归:autonomy 缺省 → 文字/语音装配走既有路径(既有 cli-voice/assembly-autonomy 等测试不破)

## 7. 验证

- [x] 7.1 worktree 根 `pnpm -r typecheck` 全绿(新适配器/装配改动不级联破坏其它包)
- [x] 7.2 worktree 根 `npx vitest run` 全绿:新增默认 provider/适配器/两路注入/语音接通/off 回归测试通过 + **既有全量回归不破**(autonomy off 缺省回归绿是硬线)
- [x] 7.3 自检与 canonical 一致:§7(真候选 / is_speaking 硬闸 / 抢占不凌驾用户)、§6/§5(memory 驱动主动)、§3.1(端口接缝不 import 内部)、§3.2(默认 + 优雅降级);确认未改 runtime/autonomy/memory/voice-detect/gateway 内部,providers 仅一处默认解析纯加法,**未碰 voice-loop.ts**
