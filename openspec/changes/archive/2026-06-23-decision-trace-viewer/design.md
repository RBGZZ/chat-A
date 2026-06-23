## Context

§8.1 要"每个行为可被完整重建"且决策 trace 是**单一真相源、无条件全量、可重放**。decision-trace-sqlite 切片已让 `SqliteDecisionTraceSink` 无损落库(schema v2,含完整决策链),但 sink **只 INSERT、不提供读路径**。真相源落了地却"查不回":要回答"她为什么这么说"得手写 SQL。本切片在 observability 包内补只读查询 + 命令行查看工具,与 sink 解耦、互不影响。

可复用:`DecisionTrace`/`DecisionTraceRecalled` 类型(decision-trace.ts)、schema v2 列定义与 `asNumber` 手法(sqlite-decision-trace.ts)、`node:sqlite`(内置无依赖)。

约束:接缝边界(reader 只读、单向,不依赖也不改 sink)、优雅降级(库不存在/损坏返回空 + 告警不崩)、行为即配置(库路径走参数/环境变量)、数据迁移纪律(reader 不建表/不迁移,只读既有 schema)、exactOptionalPropertyTypes(可选字段条件展开)。**硬约束:只改 `packages/observability/**`,不动其它包。**

## Goals / Non-Goals

**Goals:**
- 只读 `DecisionTraceReader`:列最近 N 回合(可按 sessionId 过滤)、按 turnId/correlationId/trace_id 取单回合完整决策链(JSON 列解析回对象)。
- 独立 CLI bin:`list` / `show <id>` 漂亮中文打印一回合的召回打分 / PAD情绪 / stance / system prompt / provider+model / reply / posture。
- 库不存在/损坏优雅降级,绝不崩;不改写路径、不动 sink 契约。

**Non-Goals:**
- 回放运行器(只查看不重跑);写/删/改 trace;client/runtime 接线;Web/TUI 可视化。

## Decisions

### D1:reader 独立只读打开,与 sink 解耦

`DecisionTraceReader` 用 `new DatabaseSync(path, { readOnly: true })` 打开同库,**不建表、不迁移、不写**。理由:sink 是写真相源的唯一者(单一写者),reader 跨进程/带外只读;复用 sink 句柄会把读写耦合、且 CLI 多在另一个进程跑。**备选**:给 sink 加 query 方法——会把只读关注点塞进写接缝、扩大爆炸半径,违背接缝边界,弃。

### D2:降级语义——空结果 + 告警,绝不抛

库文件不存在 / 表 `decision_traces` 缺失 / 文件损坏时,reader 捕获并经 `onWarn(err, op)` 回调(默认 `console.warn`)告警,`listRecent` 返回 `[]`、`getBy*` 返回 `undefined`。承 §3.2 优雅降级:查看工具失灵不该让人见到崩栈。打开失败也走同一路径(reader 内部 lazy/容错打开)。

### D3:行查询与 DecisionTrace 还原

按 `created_at DESC, id DESC` 取最近;`listRecent` 投影出轻量摘要行(turnId/createdAtMs/sessionId/correlationId/traceId? + userText/reply 截断摘要)。`getBy*` 取整行,JSON 列(recalled/messages/pad/stance_notions)`JSON.parse` 回对象,标量列还原为 `DecisionTrace`;可空列(traceId/spanId/pad/posture)为 NULL 时**按 exactOptionalPropertyTypes 条件展开**(不写 undefined 键),与 sink 落库口径对称。`asNumber`(bigint→number)手法复刻 sink。

### D4:CLI 形态——独立 bin,两子命令

`src/bin/trace.ts` 用 `node:util` parseArgs:
- `list [--session <id>] [--limit N] [--db <path>]`:表格式列最近回合(序号 / 时间 / turnId / 用户摘要 / reply 摘要)。
- `show <turnId|correlationId|trace_id> [--db <path>]`:分块漂亮打印整条决策链(中文小标题:基本信息 / 召回记忆+打分 / 情绪PAD / assertiveness+stance / 最终 system / messages / provider+model / reply / posture)。
库路径优先级:`--db` > `CHAT_A_DECISION_TRACE_DB` 环境变量 > 默认 `chat-a-trace.db`。`package.json` 加 `bin`(`chat-a-trace`)+ `scripts.trace`(`tsx src/bin/trace.ts`)。**不改 client**。

### D5:摘要截断

用户/回复摘要按字符数截断(默认 ~40),超出加省略号;打印时保证终端可读、不被超长 prompt 刷屏(`show` 才打印完整 system/messages)。

## Risks / Trade-offs

- **只读模式跨平台**:`node:sqlite` `readOnly: true` 在库不存在时会抛——已由 D2 容错打开 + 降级吸收。
- **schema 漂移**:reader 读固定 v2 列;若日后 sink 升级 schema,reader 需同步(reader 与 sink 同包、同 PR 演进,风险可控)。本期只读现有列,不校验版本(缺列由降级捕获)。

## Migration Plan

无数据迁移:reader 纯只读既有库;无 schema 变更;无跨包接线。新增文件 + package.json 增 bin/scripts,向后兼容。

## Open Questions

- 是否需要 `--json` 原始输出模式给下游脚本消费?本期先做人读漂亮打印,留作后续增量。
