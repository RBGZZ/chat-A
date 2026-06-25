## ADDED Requirements

### Requirement: 无 node:sqlite 环境经 better-sqlite3 持久化(二选一接缝)

在缺少内建 `node:sqlite` 的运行时(如 Electron 内嵌旧 Node),系统 SHALL 经一个**二选一加载接缝**为 `SqliteMemoryStore` 提供 SQLite 后端:先尝试 `node:sqlite` 的 `DatabaseSync`,失败则尝试 `better-sqlite3`;只有两者都不可用时,接缝 MUST 抛 `SqliteUnavailableError`,由装配层降级内存后端(承 §3.2 优雅降级,不得削弱既有降级链)。

该接缝 MUST 对 `SqliteMemoryStore` 主体透明:无论命中哪个后端,store 看到的构造器 MUST 具备一致的 DatabaseSync-shape(`prepare`/`get`/`all`/`run`/`exec`/`pragma`/`close` 与插入行 id 取法),使 store 的 SQL、schema、迁移与打分逻辑**零改动**。`node:sqlite` 路(Node ≥24 / CLI)MUST 行为逐字不变(零回归)。

两个 SQLite 后端(node:sqlite / better-sqlite3)对同一库的可观察行为 MUST 一致:写入、召回、快照、迁移、未闭合话题、closeness 演化等契约 MUST 与 node:sqlite 实现相同(单一权威,杜绝两后端漂移,承 §3.2)。WAL 等 pragma MUST 按后端归一(API 风格差异不改变落盘语义)。BLOB 列(如 `embedding`)在 better-sqlite3 经 `Buffer` 读写 MUST 与 node:sqlite 字节一致;整数列经既有 `asNumber` 兜底 MUST 不丢精度。

#### Scenario: Electron/低 Node 环境命中 better-sqlite3 并持久化

- **WHEN** 在无内建 `node:sqlite` 但已装好 better-sqlite3 的运行时,以某 DB 路径创建 `SqliteMemoryStore` 并写入若干记忆
- **THEN** 接缝命中 better-sqlite3,记忆落入该 DB 文件,可被召回,内容与写入一致

#### Scenario: 两 SQLite 后端行为一致

- **WHEN** 同一套记忆契约测试(写入/召回/快照/迁移/未闭合话题/closeness)分别经 node:sqlite 与 better-sqlite3 后端对同一 schema 运行
- **THEN** 两后端的可观察行为一致,排序与字段值无漂移

#### Scenario: node:sqlite 路零回归

- **WHEN** 在 Node ≥24(内建 `node:sqlite` 可用)运行
- **THEN** 接缝优先命中 node:sqlite,store 行为与引入二选一接缝前逐字一致

### Requirement: Electron 桌面端跨重启续接记忆与人格

在 Electron 桌面端,记忆与人格状态(PAD/OCEAN/self-notions/演化 history/closeness/巩固 trace,经 `createKvPersonaStore(mem.store)` 共用同一 `MemoryStore`)SHALL 在进程重启后续接:只要 SQLite 后端(node:sqlite 或 better-sqlite3)可用,这些状态 MUST 持久化到 DB 文件并在重启后完整可读(承 §8.1 单一真相源、§5.3b 人格/closeness 经 store)。

当两个 SQLite 后端都不可用(原生模块装不上)时,系统 MUST 优雅降级为 `InMemoryMemoryStore`:应用照常启动,文字/语音/人格/记忆查看可用,仅本次会话不跨重启留存,MUST NOT 崩溃(承 §3.2)。

#### Scenario: 桌面端重启后记忆与人格仍在

- **WHEN** 在 SQLite 后端可用的 Electron 桌面端进行若干轮对话(产生记忆并演化 PAD/人格),关闭应用后再启动并指向同一 DB
- **THEN** 之前的记忆可被召回,PAD/OCEAN/closeness 等人格状态续接上次,而非归零重置

#### Scenario: 原生模块装不上时降级内存不崩

- **WHEN** node:sqlite 与 better-sqlite3 都不可用(原生模块未装/ABI 不匹配)
- **THEN** 装配层降级 `InMemoryMemoryStore`,应用正常启动并可对话,仅提示本次不跨重启留存,不抛未捕获异常
