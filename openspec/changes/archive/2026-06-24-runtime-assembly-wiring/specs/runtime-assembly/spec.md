## ADDED Requirements

### Requirement: 感知中枢接真 A 层总线(默认关)

系统 SHALL 提供装配入口,把 runtime 的 `LightVoiceBus` 作为 `EventPublisher` 注入 interaction 的 `PerceptionHub`,注册内置 `system.tick` 源并启动,使感知信号经**真 A 层总线**以 `signal:perception` 流通(承 §12.1 / §4.2)。该装配 MUST 由 `CHAT_A_PERCEPTION` 门控,缺省/任何非 `on` 值 = **off**;off 时 MUST NOT 构造 `PerceptionHub`、MUST NOT 起 tick、MUST NOT 向总线发任何 `signal:*` 事件——既有总线行为逐字不变。`system.tick` 周期 MUST 经配置(`CHAT_A_PERCEPTION_TICK_MS`,非法/缺省回落内置默认,无 magic number)。装配 MUST 暴露 `stop()`,在会话收尾停止全部源(§3.2)。

#### Scenario: 开启时感知信号经真总线流通

- **WHEN** `CHAT_A_PERCEPTION=on`,装配感知中枢(注入真 `LightVoiceBus` + 注入式时钟/调度)并驱动一次 `system.tick` + 聚合窗 flush
- **THEN** 该 `LightVoiceBus` 收到至少一条 `action` 以 `signal:` 开头的事件(携带 description/metadata/confidence),且事件带 correlationId

#### Scenario: 关闭时零行为变更

- **WHEN** `CHAT_A_PERCEPTION` 未设置或为非 `on` 值,运行 cli 装配
- **THEN** 不构造 `PerceptionHub`、不注册任何源、总线上不出现任何 `signal:*` 事件;既有文字/语音链路行为逐字不变

### Requirement: autonomy 主动引擎上线并落 SQLite 决策 trace(默认关)

系统 SHALL 提供装配入口,把 `ProactiveTurnRunner` 包进一个 `BaseSkill`、挂上 `SkillScheduler` + 真 `LightVoiceBus`(经 `signal-adapter.ingestBusEventAsSignal` 把总线 `signal:*` 入优先级队列)+ SQLite 实现的 `AutonomyDecisionSink`(承 §7 / §8.1 / §3.1)。该装配 MUST 由既有 `isAutonomyEnabled`(`CHAT_A_AUTONOMY=on`)门控,缺省 = **off**;off 时 MUST NOT 挂调度、MUST NOT 订阅总线、MUST NOT import VoiceLoop 内部——VoiceLoop 与总线行为逐字不变。autonomy 出声 MUST 经注入的 `requestSpeak` 闭包(包 `arbitrate`),装配层 MUST NOT 直接 import runtime/VoiceLoop 内部(§3.1)。决策 sink 的 `record` MUST 不抛以致中断决策回路(内部自吞降级,§3.2);任何日志/错误 MUST NOT 含密钥明文。

#### Scenario: 开启时总线信号驱动一次主动决策并落 trace

- **WHEN** `CHAT_A_AUTONOMY=on`,以 FakeLlm(返回 speak)+ 注入时钟 + 注入决策 sink 装配 autonomy,向真总线 emit 一条 `signal:*` 事件,然后驱动一次 scheduler tick
- **THEN** 该 signal 经 `signal-adapter` 入队、被技能 tick 消费、`ProactiveTurnRunner.run` 跑出 speak,且决策(含 reason + 输入摘要)落入注入的 `AutonomyDecisionSink`

#### Scenario: autonomy 决策落 SQLite 不抛

- **WHEN** 用 SQLite `AutonomyDecisionSink`(`:memory:` 库)record 一条 `AutonomyDecisionTrace`
- **THEN** 该 trace 写入并可查询(同 correlationId 与回合 trace 缝合);`record` 在底层异常时经 onError 降级而不抛

#### Scenario: 关闭时不挂任何调度

- **WHEN** `CHAT_A_AUTONOMY` 未设置或非 `on`,运行 cli 装配
- **THEN** 不构造 `SkillScheduler`、不 `bus.onAny` 订阅、不构造决策 LLM;VoiceLoop 既有「听→想→说」与总线行为逐字不变

### Requirement: 巩固流水线触发接入会话生命周期(默认关)

系统 SHALL 提供装配入口,在 cli 会话结束(退出收尾 / `/reset` 换会话)与可选计时点调用 `Consolidator.run`(`session-end` 触发),全程**后台 fire-and-forget、幂等、失败仅告警**,绝不阻塞退出或主对话(承 §5.1 / §3.2)。该装配 MUST 由 `CHAT_A_CONSOLIDATION` 门控,缺省 = **off**;off 时 MUST NOT 构造 `Consolidator`,既有 `LlmReflector` 收尾行为不变(二者正交)。触发前 MUST 经 `shouldRun`/`Consolidator` 内部幂等检查,重复触发同一单元 MUST 安全跳过。

#### Scenario: 开启时会话结束触发巩固(幂等)

- **WHEN** `CHAT_A_CONSOLIDATION=on`,以 FakeLlm + store 装配巩固触发,在会话结束触发同一 unit 两次
- **THEN** 第一次跑巩固(后台,不阻塞退出),第二次因幂等安全跳过;任一次内部异常仅告警不抛

#### Scenario: 关闭时巩固不触发

- **WHEN** `CHAT_A_CONSOLIDATION` 未设置或非 `on`,会话结束
- **THEN** 不构造 `Consolidator`、不触发任何巩固;既有 reflect 收尾逐字不变

### Requirement: 大脑侧 WebSocket Server 入口(缺省 inprocess)

系统 SHALL 提供大脑侧 `WebSocketServer` 启动入口:监听端口,在 `connection` 事件里经 `acceptServerTransport(ws)` 得到大脑侧 `AudioTransport`,装配 STT/TTS/VAD/EOU + `send` 闭包 + `LightVoiceBus` 喂给一个 `VoiceLoop` 并 `start()`(承 §1/§2 B 方案)。大脑侧 MUST NOT 依赖本地 `AudioDevice`(下行 tts:chunk 经 transport 回终端播放)。监听端口 MUST 经配置(`CHAT_A_GATEWAY_PORT`,默认对齐 `DEFAULT_GATEWAY_URL` 的 8787)。`WebSocketServer` 实现 MUST 经**可注入工厂端口**建立,以保证单测**不开真端口、不触网**;缺省工厂在真实运行时懒加载 `ws`。连接关闭 MUST `loop.stop()` 清理。默认传输档 MUST 为 `inprocess`(终端不起 server),既有单进程语音/文字链路逐字不变。

#### Scenario: 连接到来即装配并启动 VoiceLoop

- **WHEN** 注入 fake `WebSocketServer` 工厂启动大脑侧 server,fake server emit 一个 `connection`(fake ws)
- **THEN** 经 `acceptServerTransport` 得大脑侧 transport,建出一个 `VoiceLoop` 并 `start()`(STT/TTS/VAD/EOU 在大脑侧),全程不开真端口

#### Scenario: 连接关闭即停 VoiceLoop

- **WHEN** 已建立的 fake 连接 emit `close`
- **THEN** 对应 `VoiceLoop` 被 `stop()`、资源清理;server 仍可接受后续连接

#### Scenario: 缺省 inprocess 不起 server

- **WHEN** `CHAT_A_TRANSPORT` 未设置或为 `inprocess`,运行 cli
- **THEN** 不启动大脑侧 `WebSocketServer`;既有单进程 inprocess 语音/文字链路行为逐字不变
