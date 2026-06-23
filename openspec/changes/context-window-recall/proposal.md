## Why

`MemoryStore.recall` 现在返回的是命中关键词的**离散记忆条目**（`MemoryRecord[]`）——一句句孤立的事实/偏好，丢失了它们当初产生时的对话语境。canonical §5.5 明确要"**上下文窗口拼接**：召回命中后额外取其**前后各 N 条**拼成连贯片段注入（连贯回忆 vs 零散句）"（findings §4③："命中后额外取前后各 5 条拼成连贯窗口"）。

对一个"长期伴侣"而言，"你上次说你养了只猫" 远不如 "那天你说搬完家累坏了，提到新养的猫总半夜闹你" 来得连贯有温度。把召回命中重新锚回 `messages` 时序、取其前后相邻消息，能让注入的记忆从"零散句"升格为"连贯片段"。这是 §5.5 混合召回最后一块未落地的拼图（语义/向量属 P2，本期只做时序窗口拼接）。

## What Changes

- **纯加法新增 `MemoryStore.recallWithContext(query, opts?)`**：返回 `RecalledMemory[]`——每项含原 `MemoryRecord` 加可选 `contextWindow?`（命中记忆在 `messages` 时序里前后各 N 条相邻消息）。**不改 `recall` 现有签名/返回**（向后兼容：旧调用方零改动）。
- **锚定策略（确定性、无 schema 变更）**：记忆条目不直接存消息行号，按**时间戳就近**把记忆锚回消息时序——取 `createdAtMs` 与记忆 `createdAtMs` 最接近的消息为锚点（记忆形成时所处的对话时刻），再取其前后各 N 条。两实现（内存/SQLite）共用同一锚定/取窗规则（单一权威，§3.2）。
- **跨命中去重**：多条命中的窗口若重叠，同一条消息只出现一次（按全局时序稳定排序、去重），避免注入重复对话。
- **N 走配置（行为即配置，§3.2）**：新增 `contextWindowSize` 配置项（默认 5，对齐 findings §4③），外置无 magic number；`recallWithContext` 也接受 per-call 覆盖。
- **优雅降级**：取窗读失败 / 无相邻消息 时该命中 `contextWindow` 缺省（`undefined`）或为空，绝不抛、不影响召回主结果（§3.2）。

## Capabilities

### Modified Capabilities
- `persistent-memory`: `MemoryStore` 契约**新增** `recallWithContext`（向后兼容追加，不改既有 `recall` 签名/返回）——召回命中重新锚回 `messages` 时序、拼接前后各 N 条相邻消息为连贯窗口；跨命中去重；N 外置配置；两实现同契约。

## Impact

- **canonical 章节/接缝**：§5.5（混合召回"上下文窗口拼接"落地，时序窗口部分）、§3.1（`MemoryStore` 接缝纯加法扩展）、§3.2（行为即配置 N 外置 / 单一权威取窗规则 / 优雅降级）。语义/向量召回仍归 P2。
- **代码**：仅改 `packages/memory/**`——`types.ts`（新增 `recallWithContext` 方法与 `RecalledMemory`/`ContextWindow` 类型）、`config.ts`（`contextWindowSize` + 取窗纯函数单一权威）、`in-memory-store.ts` 与 `sqlite-store.ts`（实现 `recallWithContext`）、`test/`（契约 + golden）。**不碰** runtime/conversation.ts、client/cli.ts、cognition、persona、observability、providers。
- **延迟预算（§3.2）**：取窗是召回后的本地内存/单次 SQL 范围查询，纯加法方法；旧 `recall` 热路径不受影响（默认仍走 `recall`，按需才调 `recallWithContext`）。
- **测试**：Vitest 契约/golden 覆盖：取窗正确（前后各 N）、跨命中去重、边界（命中锚点在会话首/尾）、N=0、两实现同契约 golden。

## Non-goals

- 语义 / 向量召回、混合召回的语义信号（§5.5，P2）。
- 给记忆表加"源消息行号"列做精确锚定（本期用时间戳就近锚定，零 schema 变更；精确锚列留后续）。
- 跨会话拼窗 / 按会话隔离窗口（本期按全局 `messages` 时序取窗，对齐 `snapshot` 的全局视图）。
- 改动 `recall` 的签名 / 返回结构 / 排序（保持向后兼容）。
- 改动 cognition/runtime/persona/providers/protocol/client 的任何文件。
