## Why

此前四批 change(`external-interaction-mvp` / `autonomy-runtime-wiring` / `nightly-consolidation` / `websocket-gateway-transport`)各自把「积木」打磨完整并合并 master,但它们**彼此之间、以及与 cli 装配收敛点之间仍未接线**:

- **interaction 的感知中枢**(`PerceptionHub` + `system.tick` + 内置源)已就位,但 `EventPublisher` 还没接真 `LightVoiceBus`,signal 无处流通。
- **autonomy 的主动引擎**(`ProactiveTurnRunner` / `DecisionLlm` / `SkillScheduler` / `Arbiter` / `signal-adapter` / `AutonomyDecisionSink`)已就位,但没人把 runner 装进一个 `BaseSkill`、挂上 scheduler、订阅总线 `signal:*`、把决策落 SQLite。
- **memory 的巩固器**(`Consolidator`)已就位,但只有 `LlmReflector` 在会话结束被调用,`Consolidator` 没有生命周期触发点。
- **gateway 的双端 transport**(`acceptServerTransport` / `connectClientTransport`)已就位,终端侧 `CHAT_A_TRANSPORT=websocket` 也接好了,但**大脑侧缺一个可运行的 `WebSocketServer` 启动入口**——`acceptServerTransport` 进来的连接没人喂给 VoiceLoop,双进程跑不通。

本 change 是**纯装配/接线层**:在 cli 装配收敛点(`packages/client/src/cli.ts` / `cli-voice.ts`)与新增的薄壳模块里,把这四处接成端到端可跑。**不重写任何模块内部**,只跨包接线。

**硬线(回归绿是底线)**:所有新接线**默认关 / 缺省 inprocess**;**关闭时 cli / VoiceLoop 既有行为逐字不变**——既有 1093 个测试全绿不可破。真硬件(麦克风/扬声器/真模型/真网络)**不在本 change 验证**,用 Fake/Stub + 注入端口写不触网单测。

## What Changes

- **interaction 接真总线**(默认随感知开关关):新增装配函数,把 `LightVoiceBus`(其 `emit`/`currentCorrelationId` 形态天然满足 `EventPublisher` 契约)注入 `PerceptionHub`,注册 `system.tick` 源,start 后 `signal:perception` 经真总线流通。开关 `CHAT_A_PERCEPTION=on`(缺省 off);off 时不构造 Hub、不起 tick,零行为变更。
- **autonomy 上线**(默认关):新增装配函数,把 `ProactiveTurnRunner` 包进一个 `BaseSkill`,挂 `SkillScheduler` + 真 `LightVoiceBus`(`onAny` → `signal-adapter.ingestBusEventAsSignal`)+ SQLite `AutonomyDecisionSink` 实现(把 `AutonomyDecisionTrace` 适配进 observability 的 `DecisionTraceSink`/SQLite,同 correlationId 缝合)。仅 `CHAT_A_AUTONOMY=on`(缺省 off,沿用既有 `isAutonomyEnabled`)才挂调度;off 时不挂任何东西,VoiceLoop 行为逐字不变。
- **nightly-consolidation 触发**(默认关):在 cli 会话结束(`/reset` 换会话、退出收尾)与可选计时点调 `Consolidator.run`,配置化、后台 fire-and-forget、失败仅告警。开关 `CHAT_A_CONSOLIDATION=on`(缺省 off);off 时不构造 Consolidator,既有 `LlmReflector` 收尾行为不变。
- **gateway 大脑侧入口**(新增脚本,不改默认链路):新增大脑侧 `startBrainServer` 装配函数 + 可运行脚本——用 `ws` 起 `WebSocketServer`,`connection` 事件里 `acceptServerTransport(ws)` 得大脑侧 transport,喂给 VoiceLoop(复用既有 STT/TTS/VAD/EOU 装配 + `send` 闭包);并把 `CHAT_A_TRANSPORT=websocket` 的终端↔大脑双进程跑通(文档 + 最小接线)。终端侧已有逻辑不动。

## Capabilities

### New Capabilities
- `runtime-assembly`: 端到端装配接线——感知中枢接真总线 + autonomy 上线(SQLite 决策 sink)+ 巩固触发 + 大脑侧 WebSocket server 入口;**全部默认关 / 缺省 inprocess**,关闭时既有行为逐字不变,可测(Fake/Stub 注入、不触网)、可降级(任一接线失败仅告警不拖垮主对话)。

### Modified Capabilities
<!-- 不破坏任何既有 spec REQUIREMENT:所有接线为新增能力且默认关;cli/VoiceLoop 既有「听→想→说」与文字 REPL 行为在开关 off 时逐字不变。 -->

## Impact

- **影响 canonical 章节**:§4.2(A 层总线 + 帧管线接线)、§7(autonomy 主动性上线)、§12(外界交互感知接真总线)、§8.1(autonomy 决策落 SQLite 可重放)、§3.1(只经类型化接缝/总线接线,不 import 别模块内部)、§3.2(行为即配置 + 优雅降级)。与权威设计一致。
- **代码**:`packages/client/src/`(装配收敛点 cli.ts/cli-voice.ts + 新增薄壳:autonomy 装配、perception 装配、consolidation 触发、brain-server 脚本);`packages/observability/src/`(新增 autonomy→SQLite 决策 sink 适配,纯加法);可能 `packages/protocol`(若给 `signal:*` 补类型则**只追加不重排**)。**不重写** autonomy/interaction/memory/gateway/runtime 各包内部。
- **依赖**:复用各包既有导出 + `ws`(gateway 已有);不引重型新依赖。
- **降级/默认**:四处接线**全部默认关 / 缺省 inprocess**;每处失败仅告警、不崩、不拖垮主对话(§3.2)。
- **延迟预算**:接线均在热路径之外(感知 0.3s 聚合窗、autonomy tick 由调度推、巩固后台 fire-and-forget、brain-server 是另一进程);**对用户首字延迟零影响**。
- **测试**:新增装配/开关/降级/总线连通单测(Fake/Stub + 注入端口,**不触网、不碰真硬件**);既有全量回归保持绿。
- **真机待验证(本 change 不验证)**:`CHAT_A_TRANSPORT=websocket` 的终端↔大脑真双进程免提连续对话、真麦克风感知源、真 LLM 决策主动开口。
