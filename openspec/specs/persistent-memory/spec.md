# persistent-memory Specification

## Purpose
TBD - created by archiving change sqlite-memory. Update Purpose after archive.
## Requirements
### Requirement: MemoryStore 接缝

系统 SHALL 定义一个类型化的 `MemoryStore` 接口作为记忆能力的唯一接缝，至少包含：写入（add）、召回（recall）、按近因取快照（snapshot）、按会话取消息（messagesForSession）。cognition 与 runtime MUST 只依赖该接口，不得 import 任何具体实现的内部（承 §3.1）。现有 `InMemoryMemoryStore` MUST 作为该接口的内存实现，使内存实现与 SQLite 实现可互换。

主语（`subject`）与人物归属（`personId`）SHALL 作为 `MemoryStore` 契约的一部分：写入与召回在内存实现与 SQLite 实现上对"主语默认值、主用户归属、agent 不关联人、跨主语召回"MUST 行为一致；`recall`/`addMemory` 的公共方法签名 MUST 保持向后兼容（新字段可选、有默认）。

`MemoryStore` SHALL 提供 `messagesForSession(sessionId, limit?)`，返回**指定会话**最近的若干条消息（按时序），供会话级沉淀（Reflection）使用——区别于 `snapshot` 的全局最近 N。该方法 MUST 在内存实现与 SQLite 实现上行为一致：只返回该 `sessionId` 的消息、按时序、数量受可配置上限约束；读失败 MUST 优雅降级为空数组而非抛错。新增该方法为向后兼容追加，MUST 不改动既有方法签名。

#### Scenario: 内存实现与 SQLite 实现满足同一契约

- **WHEN** 同一套契约测试分别对内存实现与 `SqliteMemoryStore` 运行
- **THEN** 两者在写入、召回、快照、主语与人物归属、按会话取消息上的可观察行为一致（重写实现用同套契约验收）

#### Scenario: 上层只依赖接口

- **WHEN** `Conversation` 编排一个回合需要读写记忆
- **THEN** 它通过注入的 `MemoryStore` 接口操作，不引用任何具体实现类型

#### Scenario: 主语与归属契约对两实现一致

- **WHEN** 同一套主语/归属契约测试（默认 person、agent 不关联人、跨主语召回、迁移后归属主用户）分别对内存实现与 SQLite 实现运行
- **THEN** 两实现的可观察行为一致

#### Scenario: 按会话取消息只返回该会话

- **WHEN** 库内存有多个会话的消息，对某一 `sessionId` 调用 `messagesForSession`
- **THEN** 仅返回该会话的消息（按时序、受上限约束），不混入其它会话；两实现行为一致

### Requirement: SQLite 作为记忆真相源并跨重启恢复

系统 SHALL 提供 `SqliteMemoryStore`，以 SQLite 数据库文件为记忆的**单一真相源**（§8.1 system-of-record）。已写入的记忆在进程重启后 MUST 完整可读，不依赖任何内存状态。数据库文件路径 MUST 可配置。

#### Scenario: 重启后记忆仍在

- **WHEN** 用一个 `SqliteMemoryStore` 写入若干记忆并关闭，再以同一 DB 路径新建实例
- **THEN** 之前写入的记忆可被召回，内容与写入时一致

#### Scenario: 首次运行自动初始化

- **WHEN** 指向一个不存在的 DB 文件创建 `SqliteMemoryStore`
- **THEN** 系统自动建库建表，写入与召回正常工作

### Requirement: 写路径 ADD + 去重

记忆写入 SHALL 走 ADD 语义（热路径只新增，不在线改写；承 §5.8，避开 Letta agentic 工具调用记忆）。写入时 MUST 做去重：与已存在记忆判定为重复的条目不产生重复行（按可配置的去重判定，如规范化文本相等）。去重 MUST 不丢失原有记忆。

#### Scenario: 重复写入只留一条

- **WHEN** 同一条记忆（规范化后等价）被写入两次
- **THEN** 存储中只存在一条该记忆

#### Scenario: 不同记忆各自保留

- **WHEN** 写入两条不等价的记忆
- **THEN** 两条都被保留，均可召回

### Requirement: 关键词召回

系统 SHALL 支持按关键词召回记忆(P1 关键词级;语义/向量检索属 P2,不在本能力范围)。召回结果 MUST 只包含命中查询关键词的记忆,数量受可配置上限约束。召回排序 SHALL 按**混合归一得分**降序返回:混合得分由若干信号路融合而成——至少包含**关键词归一分**与**记忆强度分**(`importance × decay`,承单一权威衰减/重要性公式),可选包含**情感共振分**(见"情感共振重排"需求);得分相同时 MUST 用确定性次级键(命中度、id)兜底。**关键词原始分**(命中查询 token 的去重数)MUST 经**查询长度自适应 sigmoid** 归一到 [0,1] 后参与融合,使无界原始分不压垮其它 [0,1] 信号。混合 MUST 用**自适应分母**(只除以"在场信号数",缺席信号不计入分母),保证某路信号缺席时记忆不被人为稀释。混合得分 MUST 收敛进**单一权威公式**,两实现(InMemory / SQLite)调用同一公式,不得引入第二套打分。

召回 SHALL 跨主语进行:一次 `recall` MUST 覆盖 `person`、`agent`、`shared` 三类主语的命中记忆,不按主语过滤丢弃。返回的每条 `MemoryRecord` MUST 带 `subject` 与 `personId` 标签。`recall` 的公共方法签名 MUST 保持向后兼容(融合所需的 PAD 等为**可选**入参,缺省时不改变既有排序行为)。

#### Scenario: 命中关键词的被召回

- **WHEN** 存储中有包含某关键词的记忆,以该关键词召回
- **THEN** 返回结果包含该记忆,且不包含与关键词无关的记忆

#### Scenario: 召回条数受上限约束

- **WHEN** 命中记忆数超过配置的召回上限 N
- **THEN** 最多返回 N 条,按混合归一得分取前 N

#### Scenario: 一次召回跨三类主语

- **WHEN** 存储中分别有命中同一关键词的 `person`、`agent`、`shared` 记忆,以该关键词召回(上限足够)
- **THEN** 返回结果同时包含三类主语的记忆,每条带正确的 `subject` 标签,不因主语而被过滤

#### Scenario: 多关键词命中更多者排更前

- **WHEN** 一个多 token 查询下,记忆甲命中其中多个 token、记忆乙只命中一个 token,且两者记忆强度相同
- **THEN** 关键词归一分使甲排在乙之前(命中度经自适应 sigmoid 归一后参与混合)

#### Scenario: 单关键词查询排序仍由记忆强度驱动(向后兼容)

- **WHEN** 一个单 token 查询下多条记忆均命中该 token、但记忆强度(importance×decay)不同
- **THEN** 所有候选关键词归一分相同,排序仍由记忆强度决定,结果与未引入关键词归一前一致

#### Scenario: 缺席信号不稀释得分(自适应分母)

- **WHEN** 召回未传入 PAD(情感共振路缺席)
- **THEN** 混合得分只对在场信号(关键词 + 记忆强度)取平均,情感路不计入分母,记忆得分不被一个不存在的信号压低

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

### Requirement: 行为即配置

召回上限、对话滑窗大小、去重判定等记忆行为参数 SHALL 全部外置为配置，不得出现 magic number（承 §3.2）。未提供配置时 MUST 有明确的默认值。

#### Scenario: 配置覆盖默认值

- **WHEN** 通过配置指定召回上限为 K
- **THEN** 召回行为使用 K 而非内置默认值

### Requirement: 记忆故障不拖垮主对话

记忆读写 SHALL 处于回合编排层而非 B 层实时帧管线，不进语音热路径。当记忆召回失败时，系统 MUST 降级为"无召回上下文"继续完成回合，而非让对话硬崩或无解释沉默（承 §3.2 优雅降级）。

#### Scenario: 召回失败时回合仍完成

- **WHEN** 记忆召回在某回合抛错
- **THEN** 该回合以空召回上下文继续并正常产出回复，错误被记录

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

记忆条目 SHALL 携带**重要性** `importance`(数值,初值外置为可配置默认,承 §3.2)。召回排序 MUST 将重要性与时间衰减融合为**记忆强度分** `importance × decay`,作为混合归一得分的一路在场信号(承"关键词召回"需求的混合打分);得分相同时 MUST 用确定性次级键(命中度、id)兜底,保证排序在两实现与重跑间完全确定。`MemoryRecord` MUST 携带 `importance`(及 `accessCount`、`pinned`),为**纯加法**字段,不破坏现有消费者。记忆强度公式 MUST 沿用既有单一权威 `decay = 0.5^(days/H)` 与 `importance × decay`,本变更 MUST NOT 引入第二套衰减/重要性公式。

#### Scenario: 重要性高者排序更前

- **WHEN** 两条命中同一关键词、时间衰减相同、关键词归一分相同的记忆,其一 importance 更高,以该关键词召回
- **THEN** importance 更高者排在更前

#### Scenario: 得分相同按确定性次级键排序

- **WHEN** 两条记忆的混合得分相同
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

### Requirement: 混合召回零信号门控

召回的候选过滤 MUST 只对"**全部在场信号均为 0**"的候选生效——即一个候选仅当其所有在场信号(关键词归一分、记忆强度分、可选情感共振分)都为 0 时才被丢弃。系统 MUST NOT 因某**单路**信号低或缺席而硬丢候选:关键词非零或情感共振非零(任一单路)即足以让候选进入候选池并参与排序(承 §5.5,避开 mem0 语义门控硬丢"语义不相关但情感强共振"记忆的反面教训)。该门控行为对 InMemory 与 SQLite 两实现 MUST 一致。

#### Scenario: 单路非零即进候选池

- **WHEN** 某候选的关键词分为 0、但情感共振分非零(启用情感共振时)
- **THEN** 该候选不被门控丢弃,以其在场信号参与混合排序

#### Scenario: 全零候选被丢弃

- **WHEN** 某候选的所有在场信号均为 0
- **THEN** 该候选被门控丢弃,不出现在召回结果中

### Requirement: 情感共振重排(可选)

召回 SHALL 支持基于当前 PAD 情感状态对候选做**情感共振**重排,作为混合归一得分的一路信号。该能力 MUST 经 `recall` 的**可选**入参(PAD)启用:**未传入 PAD 时 MUST 不启用情感共振**(混合得分只含关键词 + 记忆强度),保持 `recall` 签名向后兼容、排序行为与未引入情感共振前一致。启用时,系统 MUST 用 PAD/Russell 扇区**常量矩阵**(O(1) 查表)算出共振系数 ∈ [0,1],作为一路在场信号融入自适应分母混合式;情感共振 MUST NOT 单独主导排序(等权融入,避免"情感强但完全跑题"的记忆霸榜)。常量矩阵与陡度/中点等参数 MUST 外置(行为即配置,无 magic number)。PAD 类型 MUST 为 memory 包本地定义,MUST NOT 跨包 import persona(§3.1)。该能力对两实现 MUST 行为一致。

#### Scenario: 默认不启用情感共振

- **WHEN** 调用 `recall` 不传入 PAD
- **THEN** 混合得分只由关键词归一分与记忆强度分构成,排序与未引入情感共振前一致

#### Scenario: 传入 PAD 启用扇区矩阵重排

- **WHEN** 调用 `recall` 传入某 PAD 状态,候选记忆分属不同情感扇区
- **THEN** 与当前 PAD 同扇区/高共振的记忆获得更高情感共振分,在等其它信号下排序更前

#### Scenario: 情感共振不主导排序

- **WHEN** 某记忆情感共振分很高但关键词与记忆强度分很低
- **THEN** 其混合得分仍受自适应分母平均约束,不因单路情感分高而霸占榜首

#### Scenario: 两实现情感共振一致

- **WHEN** 同一 PAD 与同一组候选分别对 InMemory 与 SQLite 实现召回
- **THEN** 两实现的情感共振分与最终排序一致

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

