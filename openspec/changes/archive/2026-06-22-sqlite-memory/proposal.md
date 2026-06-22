## Why

当前小雪的记忆是**进程内滑窗**（`packages/runtime` 的 `ConversationMemory` / cognition），重启即失忆——这是离"长期伴侣"北极星最远的一块，也直接违背验收 Rubric 关系级第一条"**跨会话记得?**"。canonical §9 P1 的头牌即"SQLite 中期记忆（真相源）+ 召回 + 写路径"，且 §8.1 的"决策 trace 落库 + 可重放"也以同一个 SQLite 为真相源——记忆先落地，是后续多块的前置。

## What Changes

- **新增持久化记忆子系统**：SQLite 作为记忆的**单一真相源**（§8.1 system-of-record），进程重启后记忆完整恢复。
- **`MemoryStore` 接缝**：定义类型化记忆存储接口（写入/召回/快照），现有 `ConversationMemory` 成为它的一个内存实现；新增 `SqliteMemoryStore` 实现。cognition/runtime 只依赖接口（§3.1）。
- **写路径 ADD + 去重**（§5.8）：热路径只做 ADD + 去重（参考 mem0 ADD 语义，避开 Letta agentic 工具调用记忆）；update/delete 的离线双 Pass 调和**留后续阶段**。
- **关键词召回**（§5 召回的 P1 形态）：基于关键词/FTS 的召回，按近因/命中排序；语义/向量检索是 P2，**不在本次**。
- **schema 版本化 + 迁移骨架**（§3.2 数据迁移纪律）：记忆表带 `schema_version`，预留迁移入口，保证长期记忆不因 schema 变更丢失。
- **行为即配置**（§3.2）：召回条数、滑窗大小、去重阈值等外置为配置，不写 magic number。
- 接线到现有回合：`Conversation` 改为依赖 `MemoryStore` 接口，默认仍可用内存实现，配置切换到 SQLite。

## Capabilities

### New Capabilities
- `persistent-memory`: 小雪的持久化记忆能力——以 SQLite 为真相源的记忆写入（ADD+去重）、关键词召回、跨会话/重启恢复，以及可替换的 `MemoryStore` 接缝与 schema 版本化/迁移骨架。

### Modified Capabilities
<!-- 无既有 spec（openspec/specs/ 为空），不涉及既有 capability 的需求变更。 -->

## Impact

- **canonical 章节/接缝**：§5（记忆，本次落 §5.8 写路径的 ADD+去重子集 + 关键词召回）、§3.1（MemoryStore 接缝）、§3.2（行为即配置 / 数据迁移纪律）、§8.1（SQLite 真相源，为决策 trace 预留，本次只建记忆表）。与权威设计无冲突——本次是 §5/§9 P1 的**最小可用子集**，语义召回/巩固/调和等按 canonical 仍归 P2/后续。
- **代码**：新增 `packages/memory`（或在 cognition 内新增 `MemoryStore` + `SqliteMemoryStore`，最终位置在 design 定）；`packages/runtime/src/conversation.ts` 由直依赖 `ConversationMemory` 改为依赖 `MemoryStore` 接口；`packages/cognition` 现有 `ConversationMemory` 适配为接口实现。
- **依赖**：新增一个 SQLite 驱动（`node:sqlite` 内置 vs `better-sqlite3`，design 定；倾向先评估 `node:sqlite` 以零原生编译、利树莓派）。
- **配置**：新增记忆相关环境变量/配置项（DB 路径、召回条数、滑窗大小等）。
- **延迟预算（§3.2）**：记忆读写在**回合编排层**（非 B 层实时帧管线），不进语音热路径；SQLite 关键词召回为本地同步/毫秒级读，对回合首字延迟影响可忽略；写入在回合收尾，不阻塞流式输出。
- **测试**：Vitest 契约测试覆盖写入/去重/召回/重启恢复（接缝级，重写实现后用同套契约验收）。

## Non-goals

- 向量 / 语义检索、混合召回打分归一、情感共振（§5.5，P2）。
- Redis 工作层 + 巩固流水线（§5，P2）。
- 离线双 Pass 调和的 update/delete（§5.8，后续阶段）。
- 三层认知记忆的完整分层与统一衰减公式（本次仅最小记忆模型；衰减/分层留后续）。
- 多用户 / 用户组（§5.3b，P4）。
- 决策 trace 落库 / 可重放（§8.1，本次只让 SQLite 真相源就位，不写决策 trace 表）。
