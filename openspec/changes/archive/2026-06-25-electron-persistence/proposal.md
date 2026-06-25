## Why

Electron 桌面 app 现在**记忆/PAD/人格重启全丢**——每次启动都是"失忆的陌生人",直接违背"长期伴侣"北极星。根因已查清:

- **Electron 31 内嵌 Node 20**(lockfile `@types/node@20.19.43`),而 `node:sqlite` 自 **Node 22.5** 才引入。
- `SqliteMemoryStore` 构造时经 `loadDatabaseSync()`(`packages/memory/src/sqlite-store.ts:347-360`)`require('node:sqlite')` → 在 Electron 旧 Node 抛 → `SqliteUnavailableError`。
- 装配层 `packages/memory/src/config-loader.ts:76-89` 据此**优雅降级为 `InMemoryMemoryStore`**(应用不崩,这是对的);但——
- PAD/OCEAN/self-notions/演化 history/closeness/巩固 trace **全部经 `createKvPersonaStore(mem.store)`**(`packages/client/src/assembly/app.ts:194`)挂在**同一个内存 store** 上。于是记忆 + 人格状态全在内存,**进程一退全丢**。

现有接缝已大半就位、只差"真接":`packages/desktop/scripts/build.mjs:21` 的 external 已列 `better-sqlite3`,但**任何 package.json 都没真装它**;`rebuild` 脚本(`packages/desktop/package.json:11`)只 rebuild naudiodon。把缺的那一截补上,Electron 路就能落地持久化。

承 §8.1(SQLite 单一真相源)、§3.2(优雅降级 + 数据迁移纪律):桌面端必须能跨重启续接记忆与人格,且装不上原生模块时仍优雅降级、不崩。

> ⚠️ **本次只 propose,不改任何实现代码**。better-sqlite3 真接、electron-rebuild 扩容与真机验证需 review 后另行落地。

## What Changes

- **`loadDatabaseSync()` 改为"二选一接缝"**:先试 `node:sqlite`(Node ≥24 / CLI 路不变),失败再试 `better-sqlite3`(Electron / 低 Node 路);两者都不可用才抛 `SqliteUnavailableError` → 装配层降级内存(**优雅降级保留**)。better-sqlite3 的 `Database` 与 node:sqlite `DatabaseSync` API 近乎同构(`new Database(path)` / `prepare/run/get/all/exec` / `pragma` / `info.lastInsertRowid`),改动收敛在该加载函数 + 个别 pragma 适配。
- **WAL/pragma 适配**:node:sqlite 走 `db.exec('PRAGMA journal_mode=WAL;')`(`sqlite-store.ts:391`);better-sqlite3 推荐 `db.pragma('journal_mode = WAL')`。经接缝按实现分派,语义一致。
- **依赖与原生重建**:把 `better-sqlite3` 加为 desktop(及/或 memory)依赖;`electron-rebuild` 的 `-w` 列表从 `naudiodon` 扩到 `naudiodon,better-sqlite3`,使原生 ABI 对齐 Electron 内嵌 Node;electron-builder 打包须把原生模块按目标平台重建。
- **observability 一并(同病同治)**:`packages/observability/src/sqlite-loader.ts` 是同一 `loadDatabaseSync` 模式、同一根因。本 change 把它纳入同一二选一接缝(否则 Electron 下 trace 落盘仍会走老路)。
- **降级链不变**:node:sqlite 与 better-sqlite3 都装不上时,仍回退 `InMemoryMemoryStore`(应用照常起、文字/语音/人格/记忆查看可用,只是本次不跨重启)。

## Capabilities

### Modified Capabilities

- `persistent-memory`:新增"Electron / 低 Node 环境经 better-sqlite3 持久化"需求——在无 `node:sqlite` 的运行时,记忆 + PAD/人格(经 KvPersonaStore 共用同一 store)跨重启续接;二选一接缝对上层透明、两 SQLite 后端行为一致;原生模块装不上时降级内存不崩;node:sqlite 路(Node ≥24 / CLI)逐字不变。

> `desktop-electron-frontend` 能力是否补一条"原生模块 rebuild/打包"需求,列为 Open Question(见 design.md);本次 specs delta 只动 `persistent-memory`。

## Impact

- **改动面(实现期,本次不做)**:收敛在两个加载函数 —— `packages/memory/src/sqlite-store.ts`(`loadDatabaseSync` 二选一 + WAL pragma 分派)、`packages/observability/src/sqlite-loader.ts`(同样二选一);依赖与脚本 —— `packages/desktop/package.json`(加 `better-sqlite3` + 扩 `electron-rebuild -w`)、可能 `packages/memory/package.json`(若依赖落在 memory 包)。**SqliteMemoryStore 的 SQL / schema / 迁移 / 打分逻辑零改动**(API 同构),回归面小。
- **canonical 接缝**:§8.1(SQLite 单一真相源)、§3.2(优雅降级 / 数据迁移纪律)、§5.3b(人物花名册 / closeness 经 store 持久化)。
- **树莓派 / 嵌入式影响**:better-sqlite3 是**原生 C++ 模块**,需目标平台 ABI 编译。PC(Win/macOS/Linux x64)有预编译 prebuild,开箱即用;**树莓派 ARM** 可能需源码编译(需 node-gyp + 工具链)或可用的 ARM prebuild,属真机待验风险(见 design Open Questions)。但端侧最终形态若是 Node ≥24,可直接走 `node:sqlite` 内建路、**根本不引 better-sqlite3**——二选一接缝正是为此设计:原生依赖只在"低 Node + 持久化"才需要,且失败仍降级内存。
- **风险面**:原生 ABI 必须经 electron-rebuild 对齐 Electron 的 Node(否则 `ERR_DLOPEN_FAILED`);BLOB 在 better-sqlite3 是 `Buffer`(已兼容 `embedding` 列读写)、整数返回 `number`(现有 `asNumber` 已兜底);WAL 模式语义两实现一致。
- **非目标**:不改 SqliteMemoryStore 的记忆/打分/迁移逻辑;不升 Electron 大版本;不引 sql.js;不在本 change 内执行真机 electron-rebuild(留实现期 + 真机)。
