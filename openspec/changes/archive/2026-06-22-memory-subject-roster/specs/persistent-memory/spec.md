## ADDED Requirements

### Requirement: 记忆条目带主语

记忆条目 SHALL 携带主语 `subject ∈ {person, agent, shared}`，区分"某个人的事实/偏好/经历（person）"、"Agent 关于自己确立过的事实（agent）"、"主用户与 Agent 的共同经历（shared）"（承 §5.3）。写入接口 `MemoryInput` 的 `subject` 字段 MAY 省略，省略时 MUST 默认为 `person`；召回返回的 `MemoryRecord` MUST 始终带 `subject` 字段。该字段对内存实现与 SQLite 实现 MUST 行为一致。

#### Scenario: 写入默认归为 person 主语

- **WHEN** 写入一条记忆且不指定 `subject`
- **THEN** 该记忆以 `subject='person'` 存储，召回时其 `subject` 为 `person`

#### Scenario: 显式标注 agent / shared 主语

- **WHEN** 分别写入一条 `subject='agent'` 与一条 `subject='shared'` 的记忆
- **THEN** 两条记忆各自以对应主语存储，召回时返回的 `subject` 与写入一致

### Requirement: 人物花名册

系统 SHALL 维护一个人物花名册（people roster），至少记录每人的 `person_id`、`name`、`is_primary`、`status ∈ {primary, member, guest}`、`added_by ∈ {user, agent}`，并为 `relationship_state` 与 `voiceprint_ref` 预留可空结构（承 §5.3b）。P1 阶段花名册 MUST 在首次初始化时 seed 恰好一个主用户（`is_primary=1`、`status='primary'`、`added_by='user'`），其名字来自配置、未配置时用内置默认（行为即配置，§3.2）。本期 MUST NOT 实现说话人识别、用户组关系演化或 Agent 自主纳入访客——这些字段仅为未来扩展就位（§5.3b、Non-goals）。

#### Scenario: 首次初始化 seed 主用户

- **WHEN** 指向一个全新的存储初始化
- **THEN** 花名册中存在恰好一个 `is_primary=1`、`status='primary'`、`added_by='user'` 的主用户行

#### Scenario: 主用户名来自配置

- **WHEN** 通过配置指定主用户名为某值并初始化新存储
- **THEN** 花名册中主用户的 `name` 为该配置值；未配置时为内置默认值

### Requirement: 记忆关联人物

`person` 与 `shared` 主语的记忆 SHALL 关联到花名册中的某人 `person_id`（P1 恒为主用户）；`agent` 主语的记忆 MUST NOT 关联人物（其 `person_id` 为空）。`MemoryInput` 的 `personId` 字段 MAY 省略，对 `person`/`shared` 省略时 MUST 默认为主用户；召回返回的 `MemoryRecord` MUST 携带 `personId`，对 `agent` 主语 MUST 为空。

#### Scenario: person 记忆默认归属主用户

- **WHEN** 写入一条 `subject='person'` 且不指定 `personId` 的记忆
- **THEN** 召回该记忆时其 `personId` 为主用户的 `person_id`

#### Scenario: agent 记忆不关联人物

- **WHEN** 写入一条 `subject='agent'` 的记忆
- **THEN** 召回该记忆时其 `personId` 为空（不指向任何人物）

## MODIFIED Requirements

### Requirement: 关键词召回

系统 SHALL 支持按关键词召回记忆（P1 关键词级；语义/向量检索属 P2，不在本能力范围）。召回结果 MUST 只包含命中查询关键词的记忆，并按可配置的排序（如近因优先 / 命中度）返回，数量受可配置上限约束。

召回 SHALL 跨主语进行：一次 `recall` MUST 覆盖 `person`、`agent`、`shared` 三类主语的命中记忆，不按主语过滤丢弃，使上层在同一次召回中同时得到"关于当前说话人"、"Agent 关于自己确立过的"、"共同经历"，以防自相矛盾（承 §5.3 末条）。返回的每条 `MemoryRecord` MUST 带 `subject` 与 `personId` 标签，供上层按主语分桶注入；排序为跨主语统一的近因/命中度序。

#### Scenario: 命中关键词的被召回

- **WHEN** 存储中有包含某关键词的记忆，以该关键词召回
- **THEN** 返回结果包含该记忆，且不包含与关键词无关的记忆

#### Scenario: 召回条数受上限约束

- **WHEN** 命中记忆数超过配置的召回上限 N
- **THEN** 最多返回 N 条，按配置的排序取前 N

#### Scenario: 一次召回跨三类主语

- **WHEN** 存储中分别有命中同一关键词的 `person`、`agent`、`shared` 记忆，以该关键词召回（上限足够）
- **THEN** 返回结果同时包含三类主语的记忆，每条带正确的 `subject` 标签，不因主语而被过滤

### Requirement: schema 版本化与迁移骨架

记忆数据库 SHALL 记录 `schema_version`。当代码期望的 schema 版本高于库中版本时，系统 MUST 通过迁移入口升级，且 MUST NOT 丢失已有记忆（承 §3.2 数据迁移纪律）。版本不被识别（高于代码支持）时 MUST 明确报错而非静默损坏数据。

引入主语与人物花名册 SHALL 通过一次 schema 升版完成，其迁移 MUST 在不丢失任何存量数据的前提下：建立人物花名册、为记忆增主语与人物关联两列、seed 一个主用户，并将所有存量记忆 backfill 为 `subject='person'` 且 `personId=主用户`。迁移 MUST 与现有版本化骨架一致（顺序迁移、单事务、失败回滚）。

#### Scenario: 旧版本库被迁移且记忆保留

- **WHEN** 打开一个 schema_version 低于当前、且含已有记忆的库
- **THEN** 库被迁移到当前版本，原有记忆在迁移后仍可召回

#### Scenario: 未知的更高版本被拒绝

- **WHEN** 打开一个 schema_version 高于代码支持的库
- **THEN** 系统报明确错误，不写入也不破坏该库

#### Scenario: 升版后存量记忆归属主用户

- **WHEN** 打开一个升版前、含若干无主语记忆的库并完成迁移
- **THEN** 所有存量记忆均带 `subject='person'` 且 `personId=主用户`，可被跨主语召回，无任何记忆丢失

#### Scenario: 升版同时建立主用户花名册

- **WHEN** 一个升版前的库完成迁移
- **THEN** 花名册中存在 seed 的主用户行（`is_primary=1`、`status='primary'`）

### Requirement: MemoryStore 接缝

系统 SHALL 定义一个类型化的 `MemoryStore` 接口作为记忆能力的唯一接缝，至少包含：写入（add）、召回（recall）、按近因取快照（snapshot）。cognition 与 runtime MUST 只依赖该接口，不得 import 任何具体实现的内部（承 §3.1）。现有 `InMemoryMemoryStore` MUST 作为该接口的内存实现，使内存实现与 SQLite 实现可互换。

主语（`subject`）与人物归属（`personId`）SHALL 作为 `MemoryStore` 契约的一部分：写入与召回在内存实现与 SQLite 实现上对"主语默认值、主用户归属、agent 不关联人、跨主语召回"MUST 行为一致；`recall`/`addMemory` 的公共方法签名 MUST 保持向后兼容（新字段可选、有默认）。

#### Scenario: 内存实现与 SQLite 实现满足同一契约

- **WHEN** 同一套契约测试分别对内存实现与 `SqliteMemoryStore` 运行
- **THEN** 两者在写入、召回、快照、主语与人物归属上的可观察行为一致（重写实现用同套契约验收）

#### Scenario: 上层只依赖接口

- **WHEN** `Conversation` 编排一个回合需要读写记忆
- **THEN** 它通过注入的 `MemoryStore` 接口操作，不引用任何具体实现类型

#### Scenario: 主语与归属契约对两实现一致

- **WHEN** 同一套主语/归属契约测试（默认 person、agent 不关联人、跨主语召回、迁移后归属主用户）分别对内存实现与 SQLite 实现运行
- **THEN** 两实现的可观察行为一致
