# persistent-memory Specification

## Purpose
TBD - created by archiving change sqlite-memory. Update Purpose after archive.
## Requirements
### Requirement: MemoryStore 接缝

系统 SHALL 定义一个类型化的 `MemoryStore` 接口作为记忆能力的唯一接缝，至少包含：写入（add）、召回（recall）、按近因取快照（snapshot）。cognition 与 runtime MUST 只依赖该接口，不得 import 任何具体实现的内部（承 §3.1）。现有 `ConversationMemory` MUST 成为该接口的一个内存实现，使内存实现与 SQLite 实现可互换。

#### Scenario: 内存实现与 SQLite 实现满足同一契约

- **WHEN** 同一套契约测试分别对内存实现与 `SqliteMemoryStore` 运行
- **THEN** 两者在写入、召回、快照上的可观察行为一致（重写实现用同套契约验收）

#### Scenario: 上层只依赖接口

- **WHEN** `Conversation` 编排一个回合需要读写记忆
- **THEN** 它通过注入的 `MemoryStore` 接口操作，不引用任何具体实现类型

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

系统 SHALL 支持按关键词召回记忆（P1 关键词级；语义/向量检索属 P2，不在本能力范围）。召回结果 MUST 只包含命中查询关键词的记忆，并按可配置的排序（如近因优先 / 命中度）返回，数量受可配置上限约束。

#### Scenario: 命中关键词的被召回

- **WHEN** 存储中有包含某关键词的记忆，以该关键词召回
- **THEN** 返回结果包含该记忆，且不包含与关键词无关的记忆

#### Scenario: 召回条数受上限约束

- **WHEN** 命中记忆数超过配置的召回上限 N
- **THEN** 最多返回 N 条，按配置的排序取前 N

### Requirement: schema 版本化与迁移骨架

记忆数据库 SHALL 记录 `schema_version`。当代码期望的 schema 版本高于库中版本时，系统 MUST 通过迁移入口升级，且 MUST NOT 丢失已有记忆（承 §3.2 数据迁移纪律）。版本不被识别（高于代码支持）时 MUST 明确报错而非静默损坏数据。

#### Scenario: 旧版本库被迁移且记忆保留

- **WHEN** 打开一个 schema_version 低于当前、且含已有记忆的库
- **THEN** 库被迁移到当前版本，原有记忆在迁移后仍可召回

#### Scenario: 未知的更高版本被拒绝

- **WHEN** 打开一个 schema_version 高于代码支持的库
- **THEN** 系统报明确错误，不写入也不破坏该库

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

