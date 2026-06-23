## ADDED Requirements

### Requirement: 记忆时间衰减(单一权威公式)

召回排序 SHALL 计入**时间衰减**,使久未被提及的记忆随时间淡去。衰减 MUST 采用**单一权威公式** `decay = 0.5^(days/H)`,其中 `days` 为"自该记忆最近一次被提及(`last_seen_at`)以来的天数",`H` 为半衰期且 MUST 外置为可配置参数(无 magic number,默认 30 天,承 §5.5 / §3.2)。衰减 MUST **惰性实时计算**(召回时计算,不开后台任务、不把衰减值写回库),且全系统 MUST 只用这一套衰减公式(不得引入后台与检索两套漂移)。被标记为 `pinned` 的记忆 MUST 免于衰减(`decay=1`,核心记忆永不淡去,承 §5)。

#### Scenario: 久未提及的记忆排序靠后

- **WHEN** 两条命中同一关键词、importance 相同的记忆,其一最近被提及、另一很久以前被提及,以该关键词召回
- **THEN** 最近被提及的记忆因时间衰减更小而排在更前

#### Scenario: pinned 记忆免于衰减

- **WHEN** 一条 `pinned=1` 的记忆与一条等重要性但更新近的非 pinned 记忆命中同一关键词,且时间已远超半衰期
- **THEN** pinned 记忆的衰减因子恒为 1,不因时间流逝而被压低排序

#### Scenario: 半衰期可配置

- **WHEN** 通过配置指定半衰期 H 为某值
- **THEN** 衰减按该 H 计算(`0.5^(days/H)`),而非内置默认值

### Requirement: 记忆重要性打分与融合排序

记忆条目 SHALL 携带**重要性** `importance`(数值,初值外置为可配置默认,承 §3.2)。召回排序 MUST 将重要性与时间衰减融合为**单一权威得分** `score = importance × decay`,并按 `score` 降序返回;得分相同时 MUST 用确定性次级键(命中度、id)兜底,保证排序在两实现与重跑间完全确定。`MemoryRecord` MUST 携带 `importance`(及 `accessCount`、`pinned`),为**纯加法**字段,不破坏现有消费者(只读 `text/kind/subject/hits/personId`)。

#### Scenario: 重要性高者排序更前

- **WHEN** 两条命中同一关键词、时间衰减相同的记忆,其一 importance 更高,以该关键词召回
- **THEN** importance 更高者排在更前

#### Scenario: 得分相同按确定性次级键排序

- **WHEN** 两条记忆的融合得分相同
- **THEN** 按命中度、id 等确定性次级键稳定排序,两实现(InMemory / SQLite)与重复运行结果一致

### Requirement: 检索即强化

召回 SHALL 对**实际返回给上层的命中记忆**施加强化("被想起→记得牢",承 §5.5):`access_count` MUST 自增 1;`importance` MUST 按**单一权威公式** `importance := importance + k·(1 - importance)` 提升(`k` 外置为可配置参数,默认 0.18,数值单调趋近 1 但不超过 1);`last_accessed` MUST 更新为当前时间。强化 MUST 在"本次返回排序确定之后"施加,使本次返回的排序使用强化前的值、强化只影响后续召回(确定性)。强化的写入失败 MUST 优雅降级(不抛、不拖垮召回返回,承 §3.2)。该行为对内存实现与 SQLite 实现 MUST 一致。

#### Scenario: 命中即升重要性与访问计数

- **WHEN** 召回命中并返回某记忆一次,再次以相同关键词召回
- **THEN** 该记忆的 importance 较首次更高(按 `k·(1-importance)` 增量)、access_count 增加,从而在后续召回中排序更稳

#### Scenario: 强化系数可配置

- **WHEN** 通过配置指定强化系数 k 为某值
- **THEN** 每次命中的 importance 提升按该 k 计算,而非内置默认值

#### Scenario: 强化写入失败不拖垮召回

- **WHEN** 检索即强化的写入在某次召回中失败
- **THEN** 召回仍正常返回命中结果,错误被记录而非抛出

## MODIFIED Requirements

### Requirement: 关键词召回

系统 SHALL 支持按关键词召回记忆（P1 关键词级；语义/向量检索属 P2，不在本能力范围）。召回结果 MUST 只包含命中查询关键词的记忆，数量受可配置上限约束。召回排序 SHALL 按**融合得分** `score = importance × decay`(单一权威衰减 + 重要性,承 §5.5)降序返回,得分相同时用确定性次级键(命中度、id)兜底;不再单纯按近因/命中度排序。

召回 SHALL 跨主语进行：一次 `recall` MUST 覆盖 `person`、`agent`、`shared` 三类主语的命中记忆，不按主语过滤丢弃，使上层在同一次召回中同时得到"关于当前说话人"、"Agent 关于自己确立过的"、"共同经历"，以防自相矛盾（承 §5.3 末条）。返回的每条 `MemoryRecord` MUST 带 `subject` 与 `personId` 标签，供上层按主语分桶注入。

#### Scenario: 命中关键词的被召回

- **WHEN** 存储中有包含某关键词的记忆，以该关键词召回
- **THEN** 返回结果包含该记忆，且不包含与关键词无关的记忆

#### Scenario: 召回条数受上限约束

- **WHEN** 命中记忆数超过配置的召回上限 N
- **THEN** 最多返回 N 条，按融合得分取前 N

#### Scenario: 一次召回跨三类主语

- **WHEN** 存储中分别有命中同一关键词的 `person`、`agent`、`shared` 记忆，以该关键词召回（上限足够）
- **THEN** 返回结果同时包含三类主语的记忆，每条带正确的 `subject` 标签，不因主语而被过滤

#### Scenario: 按融合得分排序

- **WHEN** 多条命中同一关键词的记忆其重要性与时间衰减不同，以该关键词召回
- **THEN** 返回按 `importance × decay` 降序排列，重要且新近者在前；得分相同按确定性次级键稳定排序

### Requirement: schema 版本化与迁移骨架

记忆数据库 SHALL 记录 `schema_version`。当代码期望的 schema 版本高于库中版本时，系统 MUST 通过迁移入口升级，且 MUST NOT 丢失已有记忆（承 §3.2 数据迁移纪律）。版本不被识别（高于代码支持）时 MUST 明确报错而非静默损坏数据。迁移 MUST 顺序执行、单事务、失败回滚。

引入记忆评分列(`importance`、`access_count`、`last_accessed`,并预留 `pinned`、`emotion_snapshot`)SHALL 通过一次 schema 升版完成,其迁移 MUST 在不丢失任何存量数据的前提下:为 `memories` 表补列,并为历史行 backfill 默认值(`importance`=可配置初值、`access_count`=0、`pinned`=0)。补列 MUST 幂等(同一升版只跑一次),旧库历史记忆 MUST 在升版后仍可召回。

#### Scenario: 旧版本库被迁移且记忆保留

- **WHEN** 打开一个 schema_version 低于当前、且含已有记忆的库
- **THEN** 库被迁移到当前版本，原有记忆在迁移后仍可召回

#### Scenario: 未知的更高版本被拒绝

- **WHEN** 打开一个 schema_version 高于代码支持的库
- **THEN** 系统报明确错误，不写入也不破坏该库

#### Scenario: 升版后历史记忆补默认评分列且零丢失

- **WHEN** 打开一个升版前(无评分列)、含若干记忆的库并完成迁移
- **THEN** 所有历史记忆均带默认 `importance`(配置初值)、`access_count=0`、`pinned=0`,可被召回与衰减/强化,无任何记忆丢失
