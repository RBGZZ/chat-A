## 1. 只读查询接缝（observability）

- [x] 1.1 `observability/src/decision-trace-reader.ts`:`DecisionTraceReader` 类,构造期以 `node:sqlite` `DatabaseSync(path, { readOnly: true })` 容错打开(失败/不存在 → 标记降级 + 告警,不抛);`onWarn?(err, op)` 回调,默认 `console.warn`
- [x] 1.2 `listRecent({ sessionId?, limit? })`:按 `created_at DESC, id DESC` 投影摘要(turnId/createdAtMs/sessionId/correlationId/traceId? + userText/reply 截断摘要);sessionId 可选过滤;默认 limit
- [x] 1.3 `getByTurnId` / `getByCorrelationId` / `getByTraceId`:取整行还原为 `DecisionTrace`(JSON 列解析、标量还原、可空列按 exactOptionalPropertyTypes 条件展开);未命中返回 undefined
- [x] 1.4 降级:表缺失/损坏/库不存在 → list 返回 `[]`、getBy* 返回 undefined,经 onWarn 告警
- [x] 1.5 `close()` 释放只读句柄;`observability/src/index.ts` 导出 reader 及其类型

## 2. 查看 CLI（observability bin）

- [x] 2.1 `observability/src/bin/trace.ts`:`node:util` parseArgs;库路径优先级 `--db` > `CHAT_A_DECISION_TRACE_DB` > 默认 `chat-a-trace.db`
- [x] 2.2 `list [--session <id>] [--limit N]`:表格式列最近回合(序号/时间/turnId/用户摘要/reply 摘要)
- [x] 2.3 `show <turnId|correlationId|trace_id>`:分块中文漂亮打印整条决策链(基本信息/召回+打分/情绪PAD/assertiveness+stance/最终 system/messages/provider+model/reply/posture)
- [x] 2.4 库不存在/未命中 → 友好提示,不崩;`package.json` 加 `bin`(`chat-a-trace`)+ `scripts.trace`

## 3. 测试

- [x] 3.1 写入几条 trace(用 `SqliteDecisionTraceSink`)后 `listRecent` 能查回、倒序、limit 生效
- [x] 3.2 `listRecent({ sessionId })` 只返回该会话
- [x] 3.3 `getByTurnId`/`getByCorrelationId`/`getByTraceId` 取回单回合完整链,JSON 列(recalled/messages/pad/stanceNotions)解析正确、标量一致、可空列省略
- [x] 3.4 空库/不存在库降级:listRecent 返回 `[]`、getBy* 返回 undefined,不抛,告警被调用
- [x] 3.5 posture 往返:有 posture 的回合 getBy* 含 posture,无的省略

## 4. 收尾

- [x] 4.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 4.2 `npx vitest run` 全绿
