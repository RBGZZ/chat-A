## ADDED Requirements

### Requirement: 召回上下文窗口拼接

`MemoryStore` SHALL 提供 `recallWithContext(query, opts?)`，在关键词召回命中的基础上，把每条命中重新锚回对话 `messages` 时序，取其**前后各 N 条**相邻消息拼成连贯片段（承 canonical §5.5「上下文窗口拼接」）。该方法 MUST 复用 `recall` 的召回、排序与检索即强化逻辑（不另起第二套打分），仅在其结果上**追加**上下文窗口；其返回的命中顺序 MUST 与同参数 `recall` 一致。

新增 `recallWithContext` 为**向后兼容追加**：现有 `recall(query, limit?, pad?)` 的方法签名与返回结构 MUST 保持不变，旧调用方零改动。

锚定 MUST 用**时间戳就近**规则（无 schema 变更）：取 `messages` 中 `createdAtMs` 与命中记忆 `createdAtMs` 最接近的一条为锚点；同距时 MUST 取时序较早的一条作确定性兜底。窗口 MUST 为锚点及其前 N 条、后 N 条（共至多 `2N+1` 条），按对话时序排列。取窗与锚定规则 MUST 在内存实现与 SQLite 实现上行为一致（单一权威纯函数，承 §3.2）。

前后条数 N MUST 经配置外置（`contextWindowSize`，行为即配置，§3.2），并 MAY 由 `recallWithContext` 的 per-call 选项覆盖；MUST 无 magic number。

`recallWithContext` MUST 同时提供**跨命中去重的合并窗口**：所有命中各自窗口里的消息按全局时序合并后，同一条消息只出现一次。两实现 MUST 用同一稳定身份规则去重，可观察结果一致。

取窗 MUST 优雅降级（§3.2）：库内无消息、命中锚点无相邻消息、或 SQLite 读消息失败时，该命中的窗口 MUST 为空、合并窗口相应为空，且 MUST 不抛错、不影响召回主结果。

#### Scenario: 召回命中拼出前后各 N 条连贯窗口

- **WHEN** 库内存有一串按时序写入的对话消息，对一条命中其中某时刻的记忆调用 `recallWithContext`
- **THEN** 该命中的 `contextWindow` 返回锚点消息及其前 N 条、后 N 条相邻消息（按对话时序），N 取自配置或 per-call 覆盖

#### Scenario: 跨命中窗口去重

- **WHEN** 多条命中的上下文窗口在时序上重叠，对其调用 `recallWithContext`
- **THEN** 合并窗口里同一条消息只出现一次，整体按全局时序排列，无重复注入；两实现可观察结果一致

#### Scenario: 命中锚点在会话首/尾的边界收窄

- **WHEN** 命中记忆锚定到的消息位于消息时序的最前或最后
- **THEN** 窗口在缺失一侧自然收窄（首部只取锚点及其后 N 条、尾部只取锚点及其前 N 条），不越界、不报错

#### Scenario: N 外置且可 per-call 覆盖

- **WHEN** 以默认配置与以显式 `windowSize` 选项分别调用 `recallWithContext`
- **THEN** 默认取配置 `contextWindowSize`、显式覆盖时取覆盖值，窗口宽度随之变化（含 N=0 时窗口只含锚点一条）

#### Scenario: 向后兼容——recall 不变

- **WHEN** 现有调用方继续调用 `recall(query, limit?, pad?)`
- **THEN** 其方法签名、返回结构与排序保持不变，不受 `recallWithContext` 引入影响

#### Scenario: 取窗优雅降级

- **WHEN** 库内无任何消息，或取窗读取失败
- **THEN** 命中的 `contextWindow` 与合并窗口为空数组，方法不抛错，召回到的记忆主结果仍正常返回

#### Scenario: 两实现满足同一取窗契约

- **WHEN** 同一套上下文窗口契约/golden 测试分别对内存实现与 `SqliteMemoryStore` 运行
- **THEN** 两者在锚定、取窗、跨命中去重、边界与降级上的可观察行为一致
