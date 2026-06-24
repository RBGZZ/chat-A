## 1. autonomy 决策 trace → SQLite sink(observability,纯加法)

- [x] 1.1 新增 `SqliteAutonomyDecisionSink`(`packages/observability/src/`)实现 autonomy 的 `AutonomyDecisionSink`:把 `AutonomyDecisionTrace` 映射成最小 `DecisionTrace`(autonomy 决策也是「她为何开口/沉默」),写既有 `decision_traces` 表;`record` 内部自吞不抛(经 onError 降级,§8.1);同 correlationId 缝合
- [x] 1.2 `index.ts` 导出新 sink。**未引 `@chat-a/autonomy` 依赖**:改用结构化本地类型(`AutonomyDecisionTraceLike`/`AutonomyDecisionSinkLike`,与 autonomy 同构子集)实现同名 `record` 契约,observability 保持 standalone、autonomy 侧鸭子类型注入即可(§3.1 依赖倒置,避免 observability→autonomy 反向依赖)

## 2. perception 装配薄壳(接真总线,默认关)

- [x] 2.1 新增 `assemblePerception(env, bus)`(`packages/client/src/`):`CHAT_A_PERCEPTION` ≠ `on` → 返回 undefined(不构造、零开销);`on` → `new PerceptionHub({ publisher: bus, now, schedule })` + `register(createSystemTickSource({ periodMs }))` + `await start()`,返回 `{ stop }`
- [x] 2.2 `periodMs` 经 `CHAT_A_PERCEPTION_TICK_MS`(非法/缺省回落内置默认,无 magic number)

## 3. autonomy 装配薄壳(上线,默认关)

- [x] 3.1 新增 `AutonomyRunnerSkill`(`BaseSkill` 薄壳):稳定 `id`;`tick()` 从注入 `PriorityEventQueue` 取信号 → 组 `ProactiveTurnInput` → `runner.run()`;`shouldPreempt` 仅记录(不重做 runtime abort,属另一 change 范围)
- [x] 3.2 新增 `assembleAutonomy(env, { bus, llm, sessionId, decisionSink })`:`isAutonomyEnabled(env)` false → undefined(不挂任何东西);true → 建 `PriorityEventQueue` + `DecisionLlm`(注入 sink/clock)+ `ProactiveTurnRunner` + arbiter 闭包(包 `arbitrate`,不 import VoiceLoop)+ `AutonomyRunnerSkill` + `SkillScheduler`(`enabledSetConfig([skillId])`),`bus.onAny((e) => ingestBusEventAsSignal(e, queue, clock))`,返回 `{ tick, stop }`
- [x] 3.3 `tick` 驱动:`CHAT_A_AUTONOMY_TICK_MS` 定时器(失败/超时不崩);off 时不建定时器

## 4. consolidation 触发薄壳(默认关)

- [x] 4.1 新增 `assembleConsolidation(env, { llm, store })`:`CHAT_A_CONSOLIDATION` ≠ `on` → undefined;`on` → `new Consolidator({ provider: llm, store, config })`,返回 `{ consolidateSession(unit), stop }`(内部从 store 取近期记忆组 `ConsolidationInput`,`shouldRun` 后 fire-and-forget `run` + catch 告警)
- [x] 4.2 触发点:cli `cleanup()`(退出收尾,在 reflect 之后、关库之前)与 `/reset`(换会话)各触发一次 `session-end`,均 `void ...catch(告警)` 不阻塞

## 5. gateway 大脑侧 server 入口(缺省 inprocess)

- [x] 5.1 新增 `startBrainServer(deps)`(`packages/client/src/`):吃可注入 `wsServerFactory`(缺省懒加载 `ws` 的 `WebSocketServer({ port })`,`CHAT_A_GATEWAY_PORT` 默认 8787);`connection` → `acceptServerTransport(ws)` → 装配 STT/TTS/VAD/EOU + send 闭包 + `LightVoiceBus` → `new VoiceLoop({...})` + `start()`(大脑无本地设备);`close` → `loop.stop()`;返回 `{ stop }`(关 server + 所有连接)
- [x] 5.2 新增可运行入口(`package.json` 加 `dev:brain` 脚本或文档说明本地双进程跑法);终端侧逻辑不动

## 6. cli 装配收敛点接线(全部默认关 / inprocess)

- [x] 6.1 `cli.ts`:在 main 装配处按开关调 `assemblePerception` / `assembleAutonomy` / `assembleConsolidation`(各自 off 时返回 undefined,不挂);收尾 `cleanup()` 调它们的 `stop()`(幂等、失败吞)
- [x] 6.2 状态行追加各开关实际值(perception/autonomy/consolidation/transport),默认全 off/inprocess 时不喧哗
- [x] 6.3 确认 off 路径与本 change 前**逐字一致**(开关为外层 if,off 不构造/不订阅/不定时)

## 7. 测试(Fake/Stub + 注入端口,不触网、不碰真硬件)

- [x] 7.1 `assemblePerception`:on + 注入 fake schedule/clock 驱动一拍 → 真 bus 收到 `signal:perception`;off → undefined + bus 无新事件
- [x] 7.2 `assembleAutonomy`:on + FakeLlm(speak)→ bus emit `signal:*` → tick → runner.run speak → 落注入 sink;off → 不订阅、scheduler 不建
- [x] 7.3 `SqliteAutonomyDecisionSink`:`:memory:` 库 record → 可查;坏库 → onError 降级不抛
- [x] 7.4 `assembleConsolidation`:on + FakeLlm → `consolidateSession` 调 `Consolidator.run`(二次幂等跳过);off → undefined
- [x] 7.5 `startBrainServer`:注入 fake WebSocketServer + fake ws，emit `connection` → 建出 loop 并 start;emit `close` → loop.stop;不开真端口
- [x] 7.6 开关默认值回归:四开关缺省 → cli 走既有路径(可用 loadXxx 风格纯函数断言默认 off/inprocess)

## 8. 验证

- [x] 8.1 worktree 根 `pnpm -r typecheck` 全绿(新薄壳/新 sink 不级联破坏其它包)
- [x] 8.2 worktree 根 `npx vitest run` 全绿:新增装配/开关/降级/总线连通测试通过 + **既有全量回归不破**(默认关回归绿是硬线)
- [x] 8.3 自检与 canonical 一致:§4.2 总线接线、§7 autonomy 上线、§12 感知接真总线、§8.1 决策落 SQLite、§3.1 只经接缝不 import 别模块内部、§3.2 行为即配置 + 优雅降级;确认未重写各模块内部、protocol/observability 仅追加
