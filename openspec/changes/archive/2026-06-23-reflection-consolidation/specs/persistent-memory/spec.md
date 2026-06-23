## MODIFIED Requirements

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
