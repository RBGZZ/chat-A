# 设计:companion-live-wiring(伴侣主动性接成端到端真活 + 填 key 即用)

## 范围与边界

纯装配/接线层 + 一处默认解析。主战场:`packages/providers/src/config.ts`(默认 provider)+ `packages/client/**`(装配/cli/cli-voice/voice-runner + memory→autonomy 适配器)。**不碰** runtime/autonomy/memory/voice-detect/gateway 内部源码:autonomy/memory 只调既有公开 API;runtime 只**读** `VoiceLoop` 已暴露的 `speakState()` / `requestAutonomyPreempt()` / `isSpeaking`(`voice-loop.ts` 由并行 agent 改 echo-guard,本 change 绝不触碰)。

## 1. 「填 key 即用」默认 provider(`loadLlmConfig`)

现状:`provider = CHAT_A_LLM_PROVIDER ?? (hasAnthropicKey ? 'anthropic' : 'fake')`;apiKey 优先 `CHAT_A_LLM_API_KEY`,否则回落 `ANTHROPIC_API_KEY`。

改动(纯加法,仅在 `CHAT_A_LLM_PROVIDER` 未显式设时介入默认解析):

```
provider =
  CHAT_A_LLM_PROVIDER (显式) ??
  (hasAnthropicKey ? 'anthropic'
   : hasDashscopeKey ? 'qwen'
   : 'fake')
```

- `hasDashscopeKey = 非空 CHAT_A_DASHSCOPE_API_KEY`。
- 保持 anthropic 优先(向后兼容:既有同时有 anthropic+dashscope 的用户行为不变;dashscope 仅在「无 anthropic key」时改变默认,即原本会落 `fake` 的情形)。
- model 默认:provider 解析为 `qwen` 时缺省 `qwen-plus`(对齐 registry 默认);anthropic→`claude-opus-4-8`、fake→`fake-1` 不变。
- apiKey 回落:`CHAT_A_LLM_API_KEY`(通用,最高)→ 若默认解析为 qwen 则回落 `CHAT_A_DASHSCOPE_API_KEY` → 否则回落 `ANTHROPIC_API_KEY`(原逻辑)。这样仅填 DashScope key 时 qwen registry 拿得到 apiKey(它读 `cfg.apiKey`)。

显式 `CHAT_A_LLM_PROVIDER` 时本分支完全不介入(显式值原样透传);`CHAT_A_LLM_MODEL`/`CHAT_A_LLM_API_KEY` 显式给出优先于默认。

## 2. memory → autonomy 端口适配器(新文件 `packages/client/src/assembly/memory-autonomy-ports.ts`)

autonomy 包 standalone 定义端口(只认接口,§3.1);本适配器在装配层用 memory 公开 API 实现。

### OpenThreadPort 适配
`store.openThreads(limit)` 返回 `readonly MemoryRecord[]`;映射:
- `id: String(rec.id)`
- `topic: rec.text`(未了话题正文即主题摘要)
- `personId: rec.personId ?? PRIMARY`(agent 主语记忆无 personId,回落主用户 id 占位)
- `lastMentionedAtMs: rec.lastSeenAtMs`
- `dueAtMs` / `personName`:**省略**(memory 无此数据;`OpenThread` 两位均可选,候选源 `scoreThread` 在无 `dueAtMs` 时走新鲜度窗,行为正确)。

读失败 → 返回 `[]`(memory 的 `openThreads` 本身已优雅降级返回 `[]`;适配器再包一层 try 兜底)。

### PresencePort 适配(最小可用,带注释说明取舍)
memory **无直接「用户上次活跃」数据**(`MemoryStore` 无 lastActive;`people` 表无逐次互动时间戳)。故装配层维护进程内最小状态:
- `lastUserActiveAtMs`:构造时初始化为「现在」(注入时钟);提供 `markActive()` 由总线用户事件(语音 STT 终稿 / 文字输入回合)调用刷新。装配处订阅总线相应事件(或在 cli 收到用户输入时调用)以刷新。
- `currentEpisodeId()`:同一段连续空闲内稳定——用「上次活跃时刻」作 episode 键基底(`markActive` 时轮转);最小实现用 `String(lastUserActiveAtMs)`(同一活跃点内不变,新活跃即换),满足 once-per-episode 去重语义。

注释明确:这是「memory 无在场真相源」下的**装配层最小在场近似**;未来若引入真在场源(presence 服务 / 总线在场事件),替换此适配器即可,autonomy 与候选源零改(§3.1)。

## 3. 接 candidateSource(文字 + 语音两路)

两处装配点都在 autonomy on 时构造:
```ts
const clock = systemClock;            // 或注入(测试)
const otPort = createOpenThreadPort(store);
const presence = createPresencePort({ clock });
const candidateSource = combinedCandidateSource([
  openThreadCandidateSource(otPort, clock),
  idleArcCandidateSource(presence, clock),
]);
assembleAutonomy(env, { bus, llm, decisionSink, candidateSource, /* 语音另加 voiceState/preempt */ });
```
`combinedCandidateSource` 已隔离单源抛错(§3.2);`AutonomyRunnerSkill` 在候选源返回空 / 抛错时回落 signal 占位(既有逻辑)。候选只换喂料,决策裁决逻辑不变。

文字路(`cli.ts`):现有 `assembleAutonomy(env, { bus, llm, decisionSink })` 处补 `candidateSource`(autonomy on 时构造适配器;off 时 `assembleAutonomy` 仍返回 undefined,但为零开销也将候选源构造放在能复用的小工厂里,仅 on 时调用)。memory store 已有(`mem.store`)。

语音路:见 §4(语音模式此前未装配 autonomy,本 change 在拿到 VoiceLoop 处装配并注入候选源 + voiceState + preempt)。

## 4. 语音模式接 voiceState / preempt

语音模式装配链:`cli.ts` → `startVoiceMode(deps)` → `runVoiceLoop(...)` 返回 `VoiceLoopHandle { loop, bus, transport, stop }`。`loop` 即 `VoiceLoop` 实例,已暴露 `speakState(): SpeakStateView` / `requestAutonomyPreempt(reason)`。

接法(不改 voice-loop / runVoiceLoop 内部契约):
- 在能拿到 `loop` 的装配处(`startVoiceMode` 内 `runVoiceLoop` 之后,或经 `VoiceModeDeps` 传入装配回调),当 `CHAT_A_AUTONOMY=on` 时调 `assembleAutonomy(env, { bus: deps.bus, llm, decisionSink, candidateSource, voiceState: () => handle.loop.speakState(), preempt: (r) => handle.loop.requestAutonomyPreempt(r) })`,并把返回的 autonomy handle 纳入语音 `stop()` 收尾。
- llm / decisionSink:语音模式需要 llm 与 sink 来构造 autonomy。`VoiceModeDeps` 当前没有 llm/sink;为最小侵入,新增**可选** autonomy 装配钩子——cli.ts 在 on 时把一个 `assembleVoiceAutonomy?(loop, bus)` 闭包(已闭包好 env/llm/store/sink)传入 `startVoiceMode`,语音侧拿到 loop 后回调它装配并返回 handle 纳入收尾。off 时 cli 不传该钩子,语音侧零构造。

§7 约束沿用:`VoiceLoop.requestAutonomyPreempt` 内已保证用户语音 URGENT 最高、抢占不凌驾用户(B 已建);本装配只读取 API,不重写。

收尾:语音 `stop()` 增加 `autonomy?.stop()`(幂等、失败吞)。

## 测试(Fake/假 store/假 VoiceLoop 状态,不触网)

- providers 默认 provider 分支:`loadLlmConfig` 各组合(仅 dashscope→qwen+qwen-plus+key 回落 / 无任何 key→fake / 显式 provider 优先 / anthropic 现有不变 / 显式 model+key 覆盖)。
- memory→autonomy 适配器:假 store 的 `openThreads` 返回若干记录 → 适配器映射字段正确;`openThreads` 抛错 → 适配器返回 `[]`;presence 无事件回落构造时刻、markActive 刷新、episodeId 稳定/轮转。
- 文字路注入:`CHAT_A_AUTONOMY=on` + FakeLlm(speak)+ 假 store(含未了话题)+ 装配候选源 → 主动 tick → 候选来自真候选源 → 决策落 sink;off → 不构造。
- 语音路接通:假 VoiceLoop 状态(`speakState` 报 isSpeaking)注入 voiceState → arbiter 据真状态;注入 preempt + shouldPreempt → preempt 被调用;off → 不装配。
- off 回归:autonomy 缺省 → 文字/语音装配走既有路径,既有全量测试绿。

## 与 canonical 一致性

§7(主动性真候选 / is_speaking 硬闸 / 抢占不凌驾用户)、§6/§5(memory 未了话题 + 在场近似驱动主动)、§3.1(端口接缝 + 依赖倒置,不 import 别模块内部)、§3.2(行为即配置默认 + 优雅降级隔离)。未重写任何模块内部;providers 仅一处默认解析纯加法。
