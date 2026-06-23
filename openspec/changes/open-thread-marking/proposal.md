## Why

长期陪伴的一个标志性能力是**主动跟进未了之事**:用户昨天说"明天要面试",今天小雪应当主动问"面试怎么样?"(canonical §7#2 主动跟进)。要做到这点,记忆侧必须先能**标记并查询"未闭合的事(open thread)"**——哪些记忆是悬而未决、值得日后回访的,以及它们何时被闭合(已跟进/已过期)。

当前 `packages/memory` 的记忆条目(`MemoryInput`/`MemoryRecord`)只有 subject/kind/importance 等,**无"是否未闭合"的状态**,autonomy/主动回合无从挑选"该回访的话题"。本 change **只做记忆数据层**:加可选 `openThread` 标记 + `openThreads()` 查询 + `closeThread()` 闭合,为未来主动跟进铺数据;**不接 autonomy、不碰主动回合调度**。

非破坏性:纯加法可选字段 + 新方法,`addMemory`/`recall` 等既有签名向后兼容;旧库经迁移自动补默认列,消费者无需改动。

## What Changes

- **记忆条目带"未闭合"标记**:`MemoryInput` 增可选 `openThread?: boolean`(默认 false);`MemoryRecord` 增可选 `openThread?: boolean`(召回返回时恒填充)。标记"这是一件未了的事"。
- **未闭合话题查询**:`MemoryStore` 增 `openThreads(limit?)`——列出当前所有未闭合(`openThread=true` 且未闭合)的记忆,按"重要性 × 时间衰减"降序(复用既有强度公式,与 recall 同一权威)。
- **标记闭合**:`MemoryStore` 增 `closeThread(id)`——把指定记忆置为已闭合(写 `closed_at` 时间戳),令其退出 `openThreads()`。幂等(重复闭合无副作用)。
- **schema 升版 + 迁移**:`CURRENT_SCHEMA_VERSION: 4 → 5`,新增 `MIGRATIONS[5]` 加两列 `open_thread INTEGER` / `closed_at INTEGER`,backfill 存量记忆 `open_thread=0`(非未闭合)、`closed_at=NULL`;零数据丢失(§3.2)。
- **两实现同契约**:InMemory 与 SQLite 在标记/查询/闭合上行为一致,扩展共享契约测试覆盖。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `persistent-memory`: 记忆条目模型增可选 `openThread`;`MemoryStore` 接缝增 `openThreads()` 查询与 `closeThread()` 闭合;schema 升版并迁移存量数据补默认。

## Impact

- **影响 canonical 章节**:§7#2(主动跟进——本期只做其数据层,不做调度)、§5(记忆模型/强度排序)、§5.8(写路径仍 ADD;闭合是状态更新,属轻量热路径状态写,非记忆内容 update/delete)、§3.2(数据迁移纪律)。与权威设计一致,无冲突。
- **代码**:`packages/memory`——`types.ts`(MemoryInput/MemoryRecord 加可选 openThread;MemoryStore 加 openThreads/closeThread)、`sqlite-store.ts`(加列 + 迁移 + 两方法)、`in-memory-store.ts`(同契约)。**不碰其它包**(runtime/cli/persona/cognition/providers/observability/interaction)。
- **契约测试**:`test/contract.ts` 共享契约扩展——标记/查询/闭合 + 排序 golden,InMemory 与 SQLite 共跑;`test/sqlite.test.ts` 增 v4→v5 迁移用例(旧库补列、零丢失、幂等)。
- **延迟预算**:纯本地 SQLite 读写,`openThreads` 单查询(WHERE open_thread=1 AND closed_at IS NULL),`closeThread` 单行 UPDATE,不引入网络/LLM,延迟影响可忽略(§3.2)。
- **不涉及**:autonomy/主动回合调度、向量/语义召回(P2)、闭合的智能判定(本期闭合由调用方显式触发,不做"自动判过期")。
