## Why

权威设计 §12「外界交互模块」是让"小雪"能**感知**外界、**行动**于外界的统一子系统,也是 chat-A 相对开源对标的最大差异化空白。当前 `packages/interaction` 只实现了**行动侧的本地部分**(`ActionRegistry` + 6 个内置动作 + 能力门 + validate→result→execute 拆分),而:
- **感知侧完全缺失**:无 `PerceptionSource` 框架、无内置感知源、无三层去抖。
- **能力接入(MCP)完全缺失**:无 MCP client、无 `CapabilityRegistry`、无 `ProcessSupervisor`——外部能力进程/外设(设计 §3.3/§12.3 锚定 MCP 标准协议)无法接入,接缝 3 终端能力声明也无处归集。
- **行动侧缺 `TaskExecutor`**:动作未经 A 层总线异步耦合对话回合。

本变更补齐 §12.4 的 **MVP 范围**,让外界交互子系统三条腿(感知/行动/能力接入)齐备且可降级,为后续直播/游戏等演进(默认关)打地基。

## What Changes

- **感知侧(§12.1)**:`PerceptionSource` 接口(`id/modality(heard|sighted|felt|temporal|system)/start(emit)/stop/health`)+ 三层去抖(源内边沿 latch → 滑窗 detector 纯函数 → 0.3s 聚合窗)→ fire `signal:*`(带 description/metadata/confidence);内置源:**系统时钟心跳 `system.tick`**、系统通知(麦克风源由现有语音管线供给,此处只留接入点)。
- **行动侧(§12.2)**:补 `TaskExecutor`——经 §4.2 A 层总线发 `action:started/completed/failed`(带 correlationId),与对话回合异步耦合(结果回灌下回合 context),单飞行 + 取消(打断回滚)。复用既有 `ActionRegistry`。
- **能力接入(§12.3)**:**MCP client**(大脑=client,能力进程=server):`initialize`+protocolVersion → `tools/list`(分页)→ `tools/call` → `content[]`/`isError`;`notifications/tools/list_changed` = 动态 register/unregister;`CapabilityRegistry`(归集工具 + 接缝 3 终端能力声明)+ `ProcessSupervisor`(拉起/探活/崩溃自愈 指数退避+jitter/LIFO 优雅关闭);stdio 传输(本地),Streamable HTTP 留接缝。
- **边界翻译**:MCP 工具适配成 Anthropic tool 定义喂模型,强制 `mcp_server.tool` 命名空间防同名覆盖(对接现有 `interaction` 工具通道)。

## Capabilities

### New Capabilities
- `perception`: 感知源框架 + 三层去抖 + 内置源(system.tick/通知/麦克风接入点),把世界输入归一为 `signal:*` 事件,**只采集不决策**。
- `capability-access`: MCP client + CapabilityRegistry + ProcessSupervisor + TaskExecutor,外部能力进程的标准化接入、监督、调用与动作执行。

### Modified Capabilities
<!-- 既有 ActionRegistry 行为契约不变,仅新增 TaskExecutor 与 MCP 接入;无既有 spec REQUIREMENT 变更。 -->

## Impact

- **新增**:`packages/interaction/src/` 下 perception(framework + sources)、mcp(client + registry + supervisor)、task-executor 模块及其测试。
- **改动**:`interaction/index.ts` 导出;可能 `interaction/package.json` 加 MCP SDK 依赖。
- **不动**:`runtime`/`cognition`/`memory`/`persona` 业务核心(经 A 层总线解耦,§12 不做决策)。
- **降级**(§3.2):任一感知源/能力进程崩溃**不拖垮主对话**——可选能力降级不阻塞启动,核心能力受监督自愈。
- **范围**:仅 §12.4 MVP;**演进项(直播/游戏/更多 MCP 外部能力、Streamable HTTP 远端、Neuro 专有 force/priority)不做**。
- **并行安全**:几乎全在 `packages/interaction`,与其它三个并行 change 无文件重叠。
