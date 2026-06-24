# 设计:runtime-assembly-wiring(端到端装配接线)

## 总原则

- **纯装配,不重写**:本 change 只在「装配收敛点」(`packages/client/src/`)与少量薄壳里跨包接线;各模块内部(autonomy/interaction/memory/gateway/runtime)**一行不改**。给 `protocol`/`observability` 只**追加**类型/实现,不重排既有。
- **默认关 / 缺省 inprocess**:四处接线各有独立开关,缺省全 off / inprocess。**off 路径 = 既有代码路径逐字不变**(开关为外层 if,不构造、不挂、不订阅)。
- **可测不触网**:全部端口可注入(Fake LLM / Fake 时钟 / 注入 scheduler / mock WS),单测覆盖装配逻辑、开关分支、降级、总线连通。真硬件/真网络留主控手测。
- **可降级**:每处接线包 try/catch,失败仅告警(中文)+ 回落,**绝不拖垮主对话或阻塞退出**(§3.2)。

## 接缝复用(已确认的接口签名)

| 积木 | 关键接口(已存在,本 change 复用) |
| --- | --- |
| runtime 总线 | `new LightVoiceBus()`;`emit(BusEvent)` / `on(action, fn)` / `onAny(fn)` / `currentCorrelationId()` |
| interaction 感知 | `new PerceptionHub({ publisher, now, schedule })`;`.register(source)` / `.start()` / `.stop()`;`createSystemTickSource({ periodMs })` |
| interaction 发布接缝 | `EventPublisher { emit(BusEvent); currentCorrelationId?() }`——`LightVoiceBus` 形态天然兼容 |
| autonomy 调度 | `new SkillScheduler(AutonomyConfig)`;`.register(BaseSkill)` / `.tick()`;`enabledSetConfig(ids)` / `isAutonomyEnabled(env)` |
| autonomy 主动回合 | `new ProactiveTurnRunner({ decisionLlm, arbiter })`;`.run(ProactiveTurnInput)`;`new DecisionLlm({ llm, clock, sink, guardrail })` |
| autonomy 信号入队 | `ingestBusEventAsSignal(event, queue, clock)`;`new PriorityEventQueue()` |
| autonomy 决策 sink | `AutonomyDecisionSink { record(AutonomyDecisionTrace) }`(本 change 提供 SQLite 实现) |
| observability | `new SqliteDecisionTraceSink({ path })`(回合层 `DecisionTrace`);`createDecisionTraceSinkFromEnv(env)` |
| memory 巩固 | `new Consolidator({ provider, store })`;`.shouldRun(trigger, state)` / `.run(unit, input)` |
| gateway | `acceptServerTransport(ws)`(大脑侧)/ `connectClientTransport(url)`(终端侧)→ `AudioTransport` |
| runtime VoiceLoop | `new VoiceLoop({ transport, vad, turnDetector, stt, tts, send, memory, bus, sessionId })`;`.start()` / `.stop()` |

## 决策 1:interaction → 真总线(`CHAT_A_PERCEPTION`)

`EventPublisher` 接缝(`{ emit(BusEvent); currentCorrelationId?() }`)与 `LightVoiceBus`(有 `emit`/`currentCorrelationId`)**结构兼容**——直接把 bus 当 publisher 注入,无需适配器。

- 新增 `assemblePerception(env, bus)`:`CHAT_A_PERCEPTION` ≠ `on` → 返回 `undefined`(不构造、零开销);`on` → `new PerceptionHub({ publisher: bus, ... })`,`register(createSystemTickSource({ periodMs }))`,`await hub.start()`,返回 `{ stop }`。
- `periodMs` 经 `CHAT_A_PERCEPTION_TICK_MS` 配置(非法/缺省回落内置默认,无 magic number)。
- 在 cli 装配:`voiceOn` 与否都可起(感知是世界输入,不绑语音);收尾 `cleanup()` 调 `hub.stop()`。
- **off 不变性**:off 时 cli 不 import 构造 Hub,无 tick、无 `signal:*` 上总线 → 既有总线行为逐字不变。

## 决策 2:autonomy 上线(`CHAT_A_AUTONOMY`,沿用既有 flag)

最小可用主动回合:把 `ProactiveTurnRunner` 包成一个 `BaseSkill`,scheduler 驱动,总线喂 signal,决策落 SQLite。

- **AutonomyRunnerSkill**(新增薄壳 `BaseSkill`):`id` 稳定常量;`tick()`:从注入的 `PriorityEventQueue` 取一条(`signal-adapter` 入的队),组织 `ProactiveTurnInput` 候选 + context,调 `runner.run()`;`shouldPreempt` 时由接线层(注入闭包)处理(MVP 仅记录,不强接 VoiceLoop abort——抢占执行属 autonomy-runtime-wiring 的 runtime 改动范围,本装配层不重做)。
- **总线 → 队列**:`bus.onAny((e) => ingestBusEventAsSignal(e, queue, clock))`——`signal:perception`(PERCEPTION)等入队;用户 `signal:user:*`(URGENT)预留。
- **arbiter 闭包**:注入 `requestSpeak(req) => arbitrate(req, currentSpeakState())`;MVP 的 `currentSpeakState` 用一个简单标志(默认 `{ isSpeaking:false }`,或读 bus 最近 `turn:*` 推断),不 import VoiceLoop 内部。
- **决策 sink → SQLite**:新增 `SqliteAutonomyDecisionSink`(在 observability,纯加法):把 `AutonomyDecisionTrace` 映射成最小 `DecisionTrace`(autonomy 决策也是「她为何开口/沉默」,同 correlationId 缝合),写既有 `decision_traces` 表;或复用回合 sink 句柄。`record` 内部自吞不抛(§8.1 纪律)。失败/未配 → `NoopAutonomyDecisionSink`。
- **装配 `assembleAutonomy(env, { bus, llm, sessionId, traceDb })`**:`isAutonomyEnabled(env)` 为 false → 返回 `undefined`(不挂任何东西);true → 建 queue/sink/decisionLlm/runner/skill/scheduler,`enabledSetConfig([skillId])` 启用本技能,`bus.onAny` 订阅,返回 `{ tick, stop }`(`tick` 经 `CHAT_A_AUTONOMY_TICK_MS` 定时器或由 perception/语音事件驱动)。
- **off 不变性**:off 时不建 scheduler、不 onAny、不 import decision-llm → VoiceLoop 与总线行为逐字不变。

## 决策 3:nightly-consolidation 触发(`CHAT_A_CONSOLIDATION`)

`Consolidator` 已是后台、幂等、失败仅告警;本 change 只补**触发点**。

- 新增 `assembleConsolidation(env, { llm, store })`:off → `undefined`;on → `new Consolidator({ provider: llm, store, config })`,返回 `{ consolidateSession(unit, input), stop }`。
- **触发点**:cli `cleanup()`(退出收尾)与 `/reset`(换会话)时,`session-end` 触发——先判 `shouldRun`,再 `void consolidator.run(...).catch(告警)`(fire-and-forget,不阻塞退出)。可选计时:`CHAT_A_CONSOLIDATION_EVERY_MS` 周期 `daily`/`every-n-turns` 触发(MVP 可仅 session-end)。
- 巩固入参 `ConsolidationInput`(candidates/existing/episodeText)由 cli 从 `store` 取近期记忆组织(最小:取近期 episodic 作 candidates、同主题 semantic 作 existing);无材料则 `shouldRun` 仍 true 但 `run` 内部安全跳过。
- **off 不变性**:off 时不构造 Consolidator;既有 `LlmReflector.reflect` 收尾不变(二者正交:reflector=会话蒸馏,consolidator=离线调和)。

## 决策 4:gateway 大脑侧 server 入口(`CHAT_A_TRANSPORT=websocket` 双进程)

终端侧已就位(`startTerminalWebsocketMode`:device + `connectClientTransport` + `runTerminalBridge`)。缺大脑侧。

- 新增 `startBrainServer(deps)`(薄壳,在 client 或新建小模块):
  1. 懒加载 `ws` 的 `WebSocketServer({ port })`(`CHAT_A_GATEWAY_PORT`,默认 8787,对齐 `DEFAULT_GATEWAY_URL`);
  2. `connection` 事件:`const transport = acceptServerTransport(ws)`;
  3. 大脑侧装配 STT/TTS/VAD/EOU(复用 `createStt/createTts/createDetectors`)+ `send` 闭包(注入 Conversation.send)+ `new LightVoiceBus()`;
  4. `new VoiceLoop({ transport, ...detectors, stt, tts, send, memory, bus, sessionId })`,`loop.start()`;大脑无本地设备——VoiceLoop 内部把 tts:chunk `sendAudio` 回 transport,终端播放,**无需 AudioDevice**;
  5. 连接关闭 → `loop.stop()` + 清理;server 关闭 → 关所有连接。
- 新增可运行入口脚本(`package.json` 加 `dev:brain`/`start.bat` 旁路或文档说明):一行起大脑进程。
- **可测不触网**:`startBrainServer` 吃可注入的 `wsServerFactory`(默认懒加载 `ws`);单测注入 fake server + fake transport,断言「connection 来了 → 建出 VoiceLoop 并 start」「close → stop」,**不开真端口**。
- **不变性**:默认 `CHAT_A_TRANSPORT=inprocess`,不起 server;既有单进程语音/文字链路逐字不变。

## 测试策略(全不触网 / 不碰真硬件)

- `assemblePerception`:on → Hub 起、`system.tick`(注入 fake schedule/clock 驱动一拍)→ 真 bus 收到 `signal:perception`;off → 返回 undefined、bus 无新事件。
- `assembleAutonomy`:on(`CHAT_A_AUTONOMY=on`)+ FakeLlm(speak)→ bus emit 一条 `signal:*` → queue 入队 → tick → runner.run → 决策落注入的 InMemory/SQLite sink;off → 不订阅、scheduler.size=0。
- autonomy→SQLite sink:`record(AutonomyDecisionTrace)` → `:memory:` 库可查到一行;`record` 不抛(传坏库路径走 onError)。
- `assembleConsolidation`:on + FakeLlm → `consolidateSession` 调 `Consolidator.run`(幂等二次跳过);off → undefined。
- `startBrainServer`:注入 fake `WebSocketServer` + fake `ws`,emit `connection` → 断言建出 loop 并 start;emit `close` → loop.stop;不开真端口。
- **回归硬线**:所有开关缺省跑既有 cli 路径,既有 1093 测试全绿。
