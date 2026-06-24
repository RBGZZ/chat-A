## Context

`packages/interaction` 现状:`ActionRegistry`(`registry.ts`,能力门控 + `validate→result→execute` 拆分)+ `Action` 接口(`types.ts`)+ 6 个内置本地动作(set-reminder/current-time/calculate 等)。这是 §12.2 行动侧的本地部分。

缺口(§12.1/§12.3):无感知框架、无 MCP 能力接入、无 TaskExecutor。设计要求外界交互子系统挂大脑侧、经 §4.2 A 层模块总线解耦、关联 ID 贯穿,**只做"采集→归一→去抖→喂 signal"与"动作注册→执行→回灌",不做决策**(决策在 cognition),任一外部源/能力崩溃不拖垮主对话(§3.2)。

A 层总线 `LightVoiceBus`(`packages/runtime/src/bus.ts`)与 `BusEvent`(`packages/protocol`)已就位,可发布 `signal:*` / `action:*` 事件(经 AsyncLocalStorage 传 correlationId)。

## Goals / Non-Goals

**Goals:**
- `PerceptionSource` 接口 + 三层去抖管线 + 内置源(system.tick 时钟心跳、系统通知;麦克风留接入点),fire 结构化 `signal:*`。
- MCP client(stdio)接外部能力进程:initialize/版本协商 → tools/list(分页)→ tools/call,content[]/isError 解析,list_changed 动态增删。
- `CapabilityRegistry`(归集 MCP 工具 + 接缝 3 终端能力声明,统一去重 + `mcp_server.tool` 命名空间)+ `ProcessSupervisor`(拉起/探活/崩溃自愈指数退避+jitter/LIFO 关闭)。
- `TaskExecutor`:经 A 层总线 `action:started/completed/failed`、单飞行 + 取消、结果回灌为下回合 context。
- 全部可测(注入 mock MCP transport / fake source / fake clock),不依赖真实外部进程或网络。
- 优雅降级:可选能力崩溃不阻塞启动、不拖垮对话;核心能力受监督自愈。

**Non-Goals:**
- 直播(弹幕/OBS)、游戏(具身行动)等演进能力(§12.4 演进,默认关)。
- Streamable HTTP 远端传输(留接缝,本 change 仅 stdio 本地)。
- Neuro 专有 force/priority、阻塞 result、context(silent)(§3.3 🅽 暂不纳入)。
- 决策逻辑(silent|speak)——属 autonomy/cognition,由 autonomy-runtime-wiring change 负责;本 change 只产 signal,不决定是否说。
- 真实外部 MCP server 实现(本 change 只做 client 侧 + 一个用于测试的 echo/fake server stub)。

## Decisions

1. **MCP client 用官方 SDK**:采用 `@modelcontextprotocol/sdk`(TypeScript)作 client + stdio transport,避免自造 JSON-RPC/握手;若引入有阻力则降级为自写最小 client(initialize/tools.list/tools.call/notifications)。决策记入 tasks,二者择一但接口对消费者一致。
2. **感知三层去抖纯函数化**:源内边沿 latch(有状态,源自管)→ 滑窗 detector(**纯函数**,阈值走配置,可 golden test,§3.2)→ 0.3s 聚合窗(合并多源防七嘴八舌)→ `signal:*{description,metadata,confidence}`。被动触发(强信号=触发认知回合)vs 主动拉快照(时间/环境=回合内 diff 注入)分界清晰。
3. **只发总线、不调 cognition**:感知/能力子系统经 A 层 `BusEvent`(`signal:*` / `action:*`)单向发布,cognition/runtime 订阅消费——保 §12"不做决策" + §3.1 模块可重写。新增的 `signal:*`/`action:*` 事件类型加到 `protocol`(与现有 BusEvent 同构)。
4. **CapabilityRegistry = 工具 + 终端能力声明的统一归集**(§12.3/接缝 3):MCP `tools/list` 与终端"我有麦/扬/屏"都进同一 registry;对模型侧适配成 Anthropic tool 定义、强制 `mcp_server.tool` 命名空间防同名静默覆盖。
5. **ProcessSupervisor 监督策略**:核心能力强制监督(崩溃→指数退避+jitter 重启),可选能力可降级不阻塞启动;关闭走 LIFO 优雅顺序。健康探活 `health()` 周期轮询。
6. **TaskExecutor 与回合异步耦合**:动作 `action:started`→执行→`completed/failed` 回灌下回合 context;单飞行(同名动作排队/拒绝按配置)+ 取消(打断回滚,承 §4 AbortSignal)。
7. **错误双轨归因**(§3.3):JSON-RPC 协议错误 = 系统/基础设施 `fault:system`;MCP `isError:true` = 工具业务错误 `fault:tool`——映射 `protocol` 既有 Fault 归因。

## Risks / Trade-offs

- **MCP SDK 依赖体积/ARM**:官方 SDK 纯 JS 应可移植;若体积或兼容有问题,降级自写最小 client(decision 1 已留退路)。
- **stdio 子进程在 Windows/树莓派差异**:ProcessSupervisor 拉子进程需跨平台;本 change 以 stdio 为主,测试用 fake transport,真子进程行为留真机验证说明。
- **感知源七嘴八舌**:0.3s 聚合窗 + confidence 缓解;阈值全配置化,真实环境需调。
- **与 autonomy-runtime-wiring 的边界**:本 change 只产 `signal:*`,**是否据信号主动开口由 autonomy 决策**——两 change 经总线事件契约解耦,接口先定(signal 事件 schema),并行不冲突。
- **范围克制**:MVP 不接真实外部能力,只验证框架 + 一个 fake/echo MCP server;真实能力(直播/游戏)演进期再加,避免 MVP 膨胀。
