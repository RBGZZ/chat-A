## ADDED Requirements

### Requirement: 记忆条目可标记未闭合话题

记忆条目 SHALL 可被标记为"未闭合话题(open thread)"——一件悬而未决、值得日后主动回访的事(承 §7#2 主动跟进的数据层)。写入接口 `MemoryInput` 的 `openThread` 字段 MAY 省略,省略时 MUST 默认为"非未闭合"(false);召回返回的 `MemoryRecord` MUST 携带 `openThread` 标记。该字段为纯加法可选,既有 `addMemory`/`recall` 调用方 MUST NOT 因此被破坏(向后兼容)。该字段对内存实现与 SQLite 实现 MUST 行为一致。

#### Scenario: 写入默认非未闭合

- **WHEN** 写入一条记忆且不指定 `openThread`
- **THEN** 该记忆以"非未闭合"存储,不出现在未闭合话题查询中

#### Scenario: 显式标记未闭合话题

- **WHEN** 写入一条 `openThread=true` 的记忆
- **THEN** 该记忆被标记为未闭合,召回返回的 `openThread` 为 true,且出现在未闭合话题查询中

### Requirement: 未闭合话题查询

系统 SHALL 提供 `openThreads(limit?)` 查询,返回当前所有"已标记未闭合且尚未闭合"的记忆,数量受可配置上限约束。排序 MUST 按记忆强度(`importance × 时间衰减`)降序,同分按近因与稳定 id 兜底,使用与 `recall` 同一套单一权威强度公式(§5.5),内存实现与 SQLite 实现 MUST 行为一致。该查询 MUST NOT 触发检索即强化(巡检待办不等于"被想起",不得升 importance/access_count)。读失败 MUST 优雅降级为空数组,不抛(§3.2)。

#### Scenario: 只返回未闭合话题

- **WHEN** 存储中既有未闭合话题记忆、也有普通记忆与已闭合话题记忆,调用 `openThreads()`
- **THEN** 返回结果只包含"已标记未闭合且未闭合"的记忆,不含普通记忆与已闭合记忆

#### Scenario: 按记忆强度排序且受上限约束

- **WHEN** 未闭合话题数超过上限 N,各条强度(importance×decay)不同
- **THEN** 最多返回 N 条,按强度降序取前 N

#### Scenario: 查询不强化记忆

- **WHEN** 对一条未闭合话题记忆调用 `openThreads()` 后,再以关键词 `recall` 同一记忆
- **THEN** 该记忆的 importance 与 access_count 未因 `openThreads()` 而升高(巡检不计入被想起)

### Requirement: 标记话题闭合

系统 SHALL 提供 `closeThread(id)`,将指定记忆标记为已闭合(记录闭合时间),令其退出未闭合话题查询。该操作 MUST 幂等:对已闭合记忆重复调用、或对不存在/非未闭合的 id 调用,MUST 无副作用且不抛(优雅降级,§3.2)。内存实现与 SQLite 实现 MUST 行为一致。

#### Scenario: 闭合后退出未闭合查询

- **WHEN** 对一条未闭合话题记忆调用 `closeThread(id)`,再调用 `openThreads()`
- **THEN** 该记忆不再出现在返回结果中

#### Scenario: 闭合幂等

- **WHEN** 对同一记忆连续两次调用 `closeThread(id)`,或对不存在的 id 调用
- **THEN** 不抛错、无额外副作用,未闭合话题查询结果稳定

## MODIFIED Requirements

### Requirement: schema 版本化与迁移骨架

记忆数据库 SHALL 记录 `schema_version`。当代码期望的 schema 版本高于库中版本时,系统 MUST 通过迁移入口升级,且 MUST NOT 丢失已有记忆(承 §3.2 数据迁移纪律)。版本不被识别(高于代码支持)时 MUST 明确报错而非静默损坏数据。

引入未闭合话题标记 SHALL 通过一次 schema 升版完成,其迁移 MUST 在不丢失任何存量数据的前提下:为记忆增"未闭合标记"与"闭合时间"两列,并将所有存量记忆 backfill 为"非未闭合、未闭合"的默认值。迁移 MUST 与现有版本化骨架一致(顺序迁移、单事务、失败回滚、幂等只跑一次)。

#### Scenario: 旧版本库被迁移且记忆保留

- **WHEN** 打开一个 schema_version 低于当前、且含已有记忆的库
- **THEN** 库被迁移到当前版本,原有记忆在迁移后仍可召回

#### Scenario: 未知的更高版本被拒绝

- **WHEN** 打开一个 schema_version 高于代码支持的库
- **THEN** 系统报明确错误,不写入也不破坏该库

#### Scenario: 升版后存量记忆补未闭合默认

- **WHEN** 打开一个升版前、含若干无未闭合标记记忆的库并完成迁移
- **THEN** 所有存量记忆均标记为"非未闭合、未闭合",不出现在未闭合话题查询中,无任何记忆丢失

### Requirement: MemoryStore 接缝

系统 SHALL 定义一个类型化的 `MemoryStore` 接口作为记忆能力的唯一接缝,至少包含:写入(add)、召回(recall)、按近因取快照(snapshot)。cognition 与 runtime MUST 只依赖该接口,不得 import 任何具体实现的内部(承 §3.1)。现有 `InMemoryMemoryStore` MUST 作为该接口的内存实现,使内存实现与 SQLite 实现可互换。

未闭合话题能力 SHALL 作为 `MemoryStore` 契约的一部分:`openThreads(limit?)` 查询与 `closeThread(id)` 闭合在内存实现与 SQLite 实现上 MUST 行为一致(标记默认值、只返回未闭合、强度排序、巡检不强化、闭合幂等);`addMemory`/`recall` 等既有公共方法签名 MUST 保持向后兼容(新字段可选、有默认)。

#### Scenario: 内存实现与 SQLite 实现满足同一契约

- **WHEN** 同一套契约测试(含未闭合标记/查询/闭合/排序)分别对内存实现与 `SqliteMemoryStore` 运行
- **THEN** 两者在写入、召回、快照、未闭合话题标记/查询/闭合上的可观察行为一致

#### Scenario: 上层只依赖接口

- **WHEN** 上层需要列出或闭合未闭合话题
- **THEN** 它通过注入的 `MemoryStore` 接口的 `openThreads`/`closeThread` 操作,不引用任何具体实现类型
