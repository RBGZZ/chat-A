## Why

canonical §7 / `neuro-ecosystem-findings §5` 要求小雪"有自己的一天、会主动开口但不刷屏":autonomy 不做成单一 Monologue 循环,而是**可插拔后台技能** + **单消费者优先级事件队列** + **统一 requestSpeak() 输出仲裁** + **no-action 预算节流**。

本切片只造**地基引擎**(standalone,用 fake 时钟/事件源测试),**不接入 Conversation / 事件总线 / runtime**(那是后续串行切片)。目的是先把"调度/队列/仲裁/预算"这四块**确定性内核**做扎实并写 golden,再谈接线。默认全关、可配,爆炸半径可控(§3.1)。

## What Changes

新增 standalone 包 `@chat-a/autonomy`,只含纯确定性内核 + fake 驱动测试,**不被任何现有包引用**:

- **`BaseSkill` 接缝 + `SkillScheduler`**:单循环 reconcile 多个后台技能;`enabled` **每 tick 现读 config**(改配置下一 tick 生效,无重启);生命周期钩子 `initialize/start/stop/onConfigReload`;**per-skill inflight 锁**(上一 tick 未完成则跳过本 tick,不并发重入)。
- **单消费者优先级事件队列**:事件分级(`URGENT/PERCEPTION/LOWEST`),单消费者每次按优先级取最高级、同级 FIFO;**不用 `setInterval` 驱动认知**——由注入的事件源/tick 推动。
- **`requestSpeak()` 输出仲裁器**:所有技能"想说"走同一入口,据忙闲(单一 `is_speaking` 硬闸)+ 优先级/抢占,裁决 `speak | defer(记 history 待续) | drop`。
- **no-action 预算节流**:一轮无产出 → 塞合成"再想一次"事件但扣预算(默认 3,外置);外部信号(如用户开口)重置预算并丢弃排队的自言自语。

Non-goals(本切片不做):

- **不接入** Conversation / `runtime` / `LightVoiceBus` / cognition / persona / memory(后续串行切片)。
- **不实现** Neuro SDK 专有的 force/priority 主动注入、阻塞 result、`context(silent)`、撤销宽限期(§3.3 🅽 暂挂)。
- **不真的调 LLM 决策**(silent/speak)——本期只造引擎骨架,决策技能由后续切片以 BaseSkill 落地。
- **不接 OTel / SQLite trace**(standalone,无外部依赖)。
- **延迟预算(§3.2)**:本引擎全同步纯内核 + 注入时钟,不引入网络/IO;对回合延迟零影响(本就不在语音热路径)。

## Capabilities

### New Capabilities
- `autonomy`: 后台自主引擎的可插拔技能调度、单消费者优先级事件队列、requestSpeak 输出仲裁、no-action 预算节流(全确定性内核,fake 时钟/事件源驱动)。

## Impact

- 代码:**仅新增** `packages/autonomy/**`(package.json / tsconfig / src / test)。**不改任何现有包**(尤其 runtime/conversation.ts、client/cli.ts)。加入 pnpm workspace(`packages/*` 自动含)。
- 依赖:可依赖 `@chat-a/protocol`(若用事件类型);本切片内核自洽,**不依赖/修改** runtime/cognition/persona/memory。
- 已锁决策遵循:接缝化 + 依赖倒置(§3.1)、确定性内核写 golden(§3.2)、优雅降级(技能抛错被隔离不拖垮调度循环)、行为即配置(预算/优先级/enabled 全外置,无 magic number)、`exactOptionalPropertyTypes` 开。
