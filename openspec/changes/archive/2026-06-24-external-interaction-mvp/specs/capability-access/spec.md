## ADDED Requirements

### Requirement: MCP client 接入外部能力

系统 SHALL 作为 MCP client 接入外部能力进程(能力进程 = MCP server):`initialize` + protocolVersion 协商 → `tools/list`(分页)→ `tools/call{name,arguments}`,解析 `content[]`(text/image/audio/resource)与 `isError`;经 stdio 传输(Streamable HTTP 留接缝)。

#### Scenario: 列出并调用外部工具
- **WHEN** 一个 MCP server 经 stdio 连接并完成 initialize
- **THEN** client 能 `tools/list` 取得其工具,并以 `tools/call{name,arguments}` 调用,得到 `content[]` 结果

#### Scenario: 工具集动态增删
- **WHEN** MCP server 发出 `notifications/tools/list_changed`
- **THEN** client 重拉 `tools/list`,CapabilityRegistry 相应增删工具

#### Scenario: 错误双轨归因
- **WHEN** 调用返回 JSON-RPC 协议错误 vs 返回 `isError:true`
- **THEN** 前者归因 `fault:system`、后者归因 `fault:tool`(映射 protocol Fault)

### Requirement: CapabilityRegistry 归集与边界翻译

系统 SHALL 用 `CapabilityRegistry` 归集 MCP 工具与接缝 3 终端能力声明,并在边界把工具适配成 Anthropic tool 定义,强制 `mcp_server.tool` 命名空间防同名静默覆盖。

#### Scenario: 同名工具不互相覆盖
- **WHEN** 两个 MCP server 暴露同名工具
- **THEN** 在 registry 中以 `mcp_server.tool` 命名空间区分,不发生静默覆盖

#### Scenario: 终端能力声明进同一 registry
- **WHEN** 终端声明"我有麦/扬/屏"能力(接缝 3)
- **THEN** 该声明与 MCP 工具统一归入 CapabilityRegistry

### Requirement: ProcessSupervisor 进程监督与降级

系统 SHALL 用 `ProcessSupervisor` 拉起/探活/崩溃自愈(指数退避 + jitter)能力进程,核心能力强制监督、可选能力可降级不阻塞启动,关闭走 LIFO 优雅顺序。

#### Scenario: 可选能力崩溃不拖垮主对话
- **WHEN** 一个可选能力进程崩溃
- **THEN** 主对话继续可用,supervisor 按退避策略重启该进程,不阻塞系统

#### Scenario: 核心能力崩溃自愈
- **WHEN** 一个核心(强制监督)能力进程崩溃
- **THEN** supervisor 以指数退避 + jitter 重启它,并记录可追溯日志

### Requirement: TaskExecutor 异步执行动作

系统 SHALL 提供 `TaskExecutor`,经 A 层总线发 `action:started/completed/failed`(带 correlationId),与对话回合异步耦合(结果回灌下回合 context),支持单飞行与取消(打断回滚)。

#### Scenario: 动作执行经总线异步回灌
- **WHEN** 一个动作被执行
- **THEN** 依次发出 `action:started` 与 `action:completed|failed`,结果作为下一回合 context 可用

#### Scenario: 打断取消动作
- **WHEN** 动作执行中收到取消(打断)
- **THEN** 动作终止并回滚,不留半执行的脏状态
