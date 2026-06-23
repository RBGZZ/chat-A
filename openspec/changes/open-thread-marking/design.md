## Context

canonical §7#2「主动跟进」要求小雪能主动回访未了之事("你昨天说要面试,今天怎么样?")。这需要分两层:
- **数据层**(本 change):记忆能标记"这是一件未闭合的事(open thread)"、能查询当前未闭合话题、能在跟进后标记闭合。
- **调度层**(未来 change,不在本期):autonomy/主动回合从未闭合话题里挑选时机发起跟进。

本 change 只落地数据层,放进 `packages/memory`,严格不碰其它包,也不接 autonomy。

**现状基线**(实现期对齐用):
- `MemoryStore` 接缝(`types.ts`):`addMemory(rec: MemoryInput)` / `recall` / `recallWithContext` / snapshot / messagesForSession / KV / close,同步签名。
- `SqliteMemoryStore`(`sqlite-store.ts`):单文件真相源;`memory_meta.schema_version` + 顺序 `MIGRATIONS` 骨架,`CURRENT_SCHEMA_VERSION = 4`;v3 加 subject/person_id + people 表,v4 加评分列 importance/access_count/last_accessed/pinned/emotion_snapshot。
- `InMemoryMemoryStore`(`in-memory-store.ts`):同契约,无持久化,内部 `MutableRecord`。
- 强度/排序单一权威公式在 `config.ts`:`decayFactor(0.5^(days/H))`、`recallScore(importance×decay)`,两实现共用。
- 契约测试 `test/contract.ts` 由 InMemory 与 SQLite 共跑。

承 canonical 章节:**§7#2**(主动跟进数据层)、**§5**(记忆模型/强度排序)、**§5.8**(写路径 ADD;闭合是状态字段更新,非记忆内容 update/delete)、**§3.2**(数据迁移纪律:schema 版本化 + 迁移 + 零数据丢失;单一权威公式)。

## Goals / Non-Goals

**Goals:**

- 记忆条目带"未闭合"标记:`MemoryInput.openThread` 可选(默认 `false`),`MemoryRecord.openThread` 在召回/查询返回时恒填充(纯加法可选,向后兼容)。
- 查询当前未闭合话题:`MemoryStore.openThreads(limit?)` 返回"标了 openThread 且尚未闭合"的记忆,按记忆强度(`importance × decay`)降序、同分按近因/id 兜底——与 recall 同一权威排序公式,两实现零漂移。
- 标记闭合:`MemoryStore.closeThread(id)` 写 `closed_at` 时间戳令其退出 `openThreads()`;幂等(重复/对未知 id 调用无副作用、不抛)。
- schema 升至 v5,迁移加两列并 backfill 存量行为默认(`open_thread=0`、`closed_at=NULL`),零数据丢失;复刻 v3→v4 手法(ALTER ADD COLUMN + UPDATE backfill,幂等靠版本只跑一次)。
- 契约测试扩展:同一套覆盖 InMemory 与 SQLite——标记/查询/闭合/排序;确定性、无 LLM。

**Non-Goals:**

- **autonomy / 主动回合调度** —— 未来 change;本期只提供数据查询,不决定"何时/是否"发起跟进。
- **闭合的智能判定**(自动判过期、LLM 判"已跟进") —— 本期闭合由调用方显式 `closeThread(id)` 触发。
- **向量 / 语义召回** —— P2,与本 change 正交。
- **未闭合话题的 recall 融合** —— 本期 `openThreads()` 是独立查询;不改 `recall` 的命中集合与排序(向后兼容)。

## Decisions

### 决策 1:用布尔标记 `openThread` + 闭合时间戳 `closed_at` 两列,而非单一状态枚举

`MemoryInput` 增 `openThread?: boolean`(默认 `false`);schema 加两列:
- `open_thread INTEGER`(0/1,"这是否一件未了的事")
- `closed_at INTEGER`(闭合时间戳;NULL=尚未闭合)

"当前未闭合"判定 = `open_thread = 1 AND closed_at IS NULL`。

- **为什么两列而非一个三态枚举(none/open/closed)**:(a) `open_thread` 与"是否闭合"正交——一件事可以是 open-thread 且已闭合(历史可查"它何时被跟进闭合的"),保留 `closed_at` 时间戳便于未来审计/统计跟进时延;(b) 复刻既有列风格(pinned 也是 INTEGER 0/1),迁移/读取兜底一致;(c) 纯加法,旧行 backfill 为 `open_thread=0, closed_at=NULL` 语义即"非未了事、未闭合"。
- **替代方案(弃)**:复用 `kind` 字段约定值("open-thread")——污染语义(kind 是记忆种类),且无法承载闭合时间戳,也无法与未来其它 kind 共存。

### 决策 2:`openThreads()` 排序复用 recall 的记忆强度公式(单一权威),但**不做检索即强化**

`openThreads(limit?)` 候选 = 未闭合的 open-thread 记忆;排序 = `recallScore(importance, decayFactor(lastSeenAtMs, now, pinned))` 降序,同分按 `lastSeenAtMs` 近因、再按 `id` 兜底——与 `recall` 的强度路完全同一套 `config.ts` 纯函数,两实现零漂移(§3.2 单一权威公式)。

- **为什么不做检索即强化**:`openThreads()` 是"系统主动巡检待办",不是"用户提问命中"——它不代表这条记忆被想起、被用户唤起,不应升 importance/access_count(那会让待办因被巡检而虚高强度,污染 recall 排序)。这与 §5.5 检索即强化的语义("被想起→记得牢")一致:巡检 ≠ 被想起。
- **为什么不带关键词**:open-thread 查询是"列出全部待办",非按 query 召回;无关键词路,纯按强度排。

### 决策 3:`closeThread(id)` 按记忆 id 闭合,幂等且对未知 id 安全

签名 `closeThread(id: number): void`。SQLite:`UPDATE memories SET closed_at = <now> WHERE id = ? AND closed_at IS NULL`(已闭合的不重写时间戳 → 幂等);InMemory:同语义改 `MutableRecord.closedAtMs`。对不存在的 id 或非 open-thread 的 id 调用:无副作用、不抛(优雅降级,§3.2)。

- **为什么用 id 而非文本**:id 是 `MemoryRecord` 已暴露的稳定主键,调用方从 `openThreads()`/`recall()` 拿到 record 后直接闭合;文本需再规范化匹配、且去重后一对多不稳定。
- **闭合是否仍属 §5.8"热路径只 ADD"**:闭合是**轻量状态字段更新**(写一个时间戳),非记忆内容的 update/delete(§5.8 要移离线的是"改写/删除记忆文本/合并"这类重活)。pinned 之类状态列同理可热写。语义上"标记跟进完成"必须即时,不能等离线巩固。

### 决策 4:schema 升至 v5,单条迁移加两列 + backfill,全程一个事务

`CURRENT_SCHEMA_VERSION: 4 → 5`,新增 `MIGRATIONS[5]`:
1. `ALTER TABLE memories ADD COLUMN open_thread INTEGER`;`ADD COLUMN closed_at INTEGER`(SQLite 加列默认 NULL;幂等靠 v5 只在 `schema_version<5` 跑一次,同 v3/v4 手法)。
2. backfill 存量记忆:`UPDATE memories SET open_thread = 0 WHERE open_thread IS NULL`(旧记忆视作"非未了事";`closed_at` 容 NULL 即"未闭合",无需显式写)。

迁移跑在现有 `#migrate()` 的 `BEGIN/COMMIT` 事务里,失败 `ROLLBACK`;版本号经 `memory_meta.schema_version` 推进;高于代码支持仍报错。读取侧对旧库残留 NULL 兜底(`open_thread` NULL → false)。

- **为什么 backfill `open_thread=0` 而非依赖 `ADD COLUMN DEFAULT 0`**:复刻 v3/v4 既定手法——显式 `UPDATE ... WHERE IS NULL` 语义清晰、可断言、可回放;读取侧也对 NULL 兜底,双保险。
- **InMemory 同契约**:InMemory 无 schema,但新写入应用同默认(`openThread ?? false`),`MutableRecord` 加 `openThread`/`closedAtMs` 字段,两实现行为一致。

## Risks / Trade-offs

- **[新增两列但 P1 消费者尚未接入(autonomy 未来才用)]** → 接受:这是 §7#2 主动跟进的有意前置数据投资,符合数据迁移纪律"结构先就位免未来重构";空列不影响延迟与现有 recall。
- **[`openThreads()` 不做检索即强化,与 recall 行为不同,可能让人困惑]** → 缓解:语义明确(巡检 ≠ 被想起),在方法注释与契约测试中固化"巡检不升强度";避免待办虚高污染 recall。
- **[闭合用 id,若调用方持有过期 id(记忆被去重合并)可能闭错]** → 缓解:P1 去重是 ADD 时 `ON CONFLICT(normalized_text)` 累加 hits,不改变已存在行的 id,id 稳定;`closeThread` 对未知 id 安全无副作用。
- **[闭合是状态热写,是否违 §5.8 写路径只 ADD]** → 已论证(决策 3):闭合是轻量状态字段更新(同 pinned 列),非记忆内容 update/delete;§5.8 要移离线的是重活(改写/合并/删除),不含状态标记。
- **[延迟]** → 纯本地 SQLite,`openThreads` 单查询带 WHERE、`closeThread` 单行 UPDATE,影响可忽略(§3.2),不引入网络/LLM。
