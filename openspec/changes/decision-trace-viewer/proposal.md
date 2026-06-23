## Why

canonical §8.1 把"每个行为可被完整重建"列为**开发期硬要求**,且明确决策 trace 是**单一真相源、无条件全量、可重放**。我们已让 `SqliteDecisionTraceSink` **无损落库**(decision-trace-sqlite 切片),但库**只写不可读**——出现"她为什么这么说"时,数据躺在 `chat-a-trace.db` 里却**没有任何手段查回**:既看不到最近几回合、也无法按 turnId/correlationId/trace_id 调出单回合的完整决策链。§8.1 的"可重放"只完成了"持久化"一半,缺"查看/回放"另一半。本切片补上**只读查询 + 回合查看工具**,让落库的真相源真正可用。

## What Changes

- **新增只读 `DecisionTraceReader`**(observability):用 `node:sqlite` 以**只读**方式打开同库,提供:
  - `listRecent({ sessionId?, limit? })`:列出最近 N 回合(可按 sessionId 过滤),返回 turnId / 时间 / 用户输入摘要 / reply 摘要 + 缝合键(correlationId/traceId)。
  - `getByTurnId` / `getByCorrelationId` / `getByTraceId`:取单回合**完整决策链**,JSON 列(recalled/messages/pad/stanceNotions)解析回对象,标量列还原为 `DecisionTrace` 形状。
  - 库不存在 / 表缺失 / 损坏 → **优雅降级**(返回空结果 + 告警回调,绝不崩)。
- **新增独立 CLI bin**(observability,`src/bin/trace.ts` + package.json `bin`/`scripts`):把一回合的 **召回+打分 / 情绪PAD / assertiveness+stance / 最终 system prompt / provider+model / reply / posture** 漂亮打印(中文)。支持 `list`(列最近)与 `show <id>`(看单回合)两个子命令。
- **只读、不改写路径**:不动 `SqliteDecisionTraceSink` 的 sink 契约与 INSERT 路径,reader 与 sink 共享 schema 但相互独立。

Non-goals(本切片不做):

- **回放运行器**(从一条 trace 重跑回合复现 bug):本期只**查看/打印**已落数据,重跑另开。
- **写/删/改 trace**:reader 纯只读;sink 契约一字不改。
- **跨包接线**(client/runtime):本切片只在 observability 内提供库与独立 bin,**不动 client/cli.ts**。
- **Web/TUI 可视化**:本期为命令行漂亮打印,GUI 留待后续。

## Capabilities

### New Capabilities
<!-- 纯增量:在既有 decision-trace 能力上加"只读查询 + 查看工具" -->

### Modified Capabilities
- `decision-trace`: 新增**只读查询接缝 `DecisionTraceReader`** 与**回合查看 CLI**——在既有"无条件全量落库"之上补齐"查回/回放查看",库不存在/损坏优雅降级;不改写路径、不动 sink 契约。

## Impact

- **延迟预算(§3.2)**:reader 与 CLI 为**离线/带外**工具,不在回合热路径,对首字/回合延迟零影响。
- 代码:
  - `@chat-a/observability`:新增 `decision-trace-reader.ts`(`DecisionTraceReader` + 只读打开 + 查询 + 降级)、`src/bin/trace.ts`(CLI 漂亮打印),`index.ts` 导出 reader,`package.json` 加 `bin`/`scripts`。
- 数据:**纯只读**同库,不动 schema、不动记忆库;库不存在/损坏只返回空 + 告警。
- 已锁决策:接缝边界(只读单向、与 sink 解耦)、优雅降级、行为即配置(库路径走参数/环境变量)均遵循;**不改其它任何包**(client/runtime/memory/persona 零改动)。
