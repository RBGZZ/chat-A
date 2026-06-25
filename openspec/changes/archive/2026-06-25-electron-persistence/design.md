# 设计:electron-persistence

## 背景与约束

- **目标运行时是双轨的**:CLI / 未来端侧 Node ≥24 有内建 `node:sqlite`;Electron 31 内嵌 Node 20 没有。两条路要共用同一套 `SqliteMemoryStore`(同 SQL / schema / 迁移 / 打分),不能分叉两份实现(承 §3.2 单一权威、爆炸半径可控)。
- **优雅降级是硬约束(§3.2)**:任何 SQLite 后端都装不上时,装配层 `config-loader` 必须仍能回退 `InMemoryMemoryStore`,应用照常起。本 change 只新增一条"能持久化"的路,不削弱降级链。
- **API 同构是落地前提**:better-sqlite3 `Database` ↔ node:sqlite `DatabaseSync` 的方法形状几乎一致:`new Database(path)`、`db.prepare(sql)`、`stmt.run/get/all(...params)`、`db.exec(sql)`、`db.pragma(...)`、`stmt.run().lastInsertRowid`(better-sqlite3)≈ `info.lastInsertRowid`(node:sqlite)。差异点逐一在下方决策处理。

## 决策

### D1 —— `loadDatabaseSync()` 改为"二选一"接缝(node:sqlite 优先,better-sqlite3 兜底)

把 `packages/memory/src/sqlite-store.ts:347-360` 的加载函数改为:先 `require('node:sqlite').DatabaseSync`;`catch` 后再试 `require('better-sqlite3')`;两者都失败才抛 `SqliteUnavailableError`(语义不变,装配层据此降级内存)。

返回的对象必须暴露一个**统一的 DatabaseSync-shape 构造器**(`new Db(path)` 后具备 `prepare/get/all/run/exec/pragma/close` 与 `lastInsertRowid` 取法)。两后端 API 已同构,差异点(pragma、lastInsertRowid)由接缝内归一,使 `SqliteMemoryStore` 主体**零感知用的是哪个后端**。

- **为何 node:sqlite 优先**:CLI / Node ≥24 路逐字不变,零回归;better-sqlite3 只在内建缺席时才被引入(原生依赖按需,端侧若 Node ≥24 可完全不装)。
- **收敛点**:改动只在加载函数 + 接缝归一,SqliteMemoryStore 的 SQL/schema/迁移/打分**一行不动**。

### D2 —— WAL / pragma 适配

`sqlite-store.ts:391` 现用 `db.exec('PRAGMA journal_mode=WAL;')`。node:sqlite 与 better-sqlite3 **都支持** `exec('PRAGMA ...')`,但 better-sqlite3 官方推荐 `db.pragma('journal_mode = WAL')`(返回结果、更稳)。接缝按实际后端提供一个统一 `setWal(db)`(或保留 `exec` 走两边,实测确认),语义一致(WAL 落盘行为相同)。其余 `db.exec('BEGIN'/'COMMIT'/'ROLLBACK')` 事务语句两后端一致,不需改。

### D3 —— 依赖与 electron-rebuild 扩容

- 把 `better-sqlite3` 加为依赖。**落点二选一**(Open Question Q3):放 `@chat-a/desktop`(只 Electron 路需要,memory 包保持纯)或放 `@chat-a/memory`(就近 store)。倾向 **desktop**:memory 包对 node:sqlite 是内建零依赖,better-sqlite3 是"Electron 宿主才需"的运行时补丁,放宿主包更贴近"按需"语义,且 build.mjs external 已在 desktop。
- `packages/desktop/package.json:11` 的 `electron-rebuild -f -w naudiodon` 扩为 `-w naudiodon,better-sqlite3`,使原生 ABI 同时对齐 Electron 内嵌 Node。
- electron-builder `package` 脚本须确保打包时按目标平台重建原生模块(`nativeRebuild` 默认开,但需真机确认 better-sqlite3 prebuild / 重建链路)。

### D4 —— 降级链保留(优雅降级不削弱)

二选一接缝在两后端都不可用时仍抛 `SqliteUnavailableError`,`config-loader.ts:81-87` 的现有 `catch` 逻辑**一字不改**即可继续降级 `InMemoryMemoryStore`。即:新增 better-sqlite3 是在 node:sqlite 与内存兜底**之间**插一层,不替换任何现有分支。

### D5 —— observability sqlite-loader 同批

`packages/observability/src/sqlite-loader.ts` 的 `loadDatabaseSync` 是同一模式、同一根因(Electron 下 trace 落盘会走同一坑)。同批改为同样的二选一接缝,避免"记忆持久化好了、trace 落盘仍降级"的半吊子。两处接缝逻辑相同,可考虑抽一个共享 loader(实现期定,不强制)。

## 方案对比

| 方案 | 持久化 | 改动面 | 端侧/树莓派 | 风险 | 取舍 |
|---|---|---|---|---|---|
| **A. better-sqlite3 二选一接缝(选)** | ✅ 文件真持久化,与 node:sqlite 同库格式 | 小:两个加载函数 + 依赖 + rebuild;store 主体零改 | Node ≥24 走内建零依赖;低 Node 需 ARM prebuild/编译 | 原生 ABI 须 electron-rebuild 对齐 | API 同构、改动收敛、降级保留——**最优** |
| B. 升 Electron 到内嵌 Node ≥22.5/24 | ✅ 直接用 node:sqlite,零原生新依赖 | 中:Electron 大版本跳跃,牵连 preload/sandbox/构建 | 干净 | 大版本回归面广、生态/原生模块(naudiodon)兼容未知 | 一步到位但风险与排期不可控,**劣** |
| C. sql.js(wasm) | ⚠️ 全内存 SQLite,需手动序列化落盘 | 大:存储模型从"文件单一真相源"变"内存+手动 flush",违 §8.1 | 跨平台无原生编译 | 全内存,大库内存压力;flush 时机/崩溃丢数据 | 适配大、违真相源纪律,**劣** |

## 风险与缓解

- **原生 ABI 编译(R-ABI)**:better-sqlite3 必须经 electron-rebuild 重建到 Electron 的 Node ABI,否则 `require` 抛 `ERR_DLOPEN_FAILED`。缓解:D3 扩 `-w` 列表;真机验证后才算闭环(tasks 标"待真机")。装失败仍降级内存(D4),不阻断应用启动。
- **BLOB / bigint(R-TYPE,已基本兼容)**:better-sqlite3 BLOB 读出为 `Buffer`(`embedding` 列读写已是字节,兼容);整数默认 `number`,现有 `asNumber()`(`sqlite-store.ts:304`)已兜底;超大整数(本库无)才需 `safeIntegers`。判定:无需改 SQL,接缝层确认即可。
- **WAL 语义(R-WAL,低)**:两后端 WAL 落盘语义一致,仅 API 风格差异(D2 归一)。
- **真机工具链(R-TOOL)**:electron-rebuild / 源码编译需 node-gyp + C++ 工具链(Win 需 MSVC build tools、Linux/ARM 需 gcc)。PC 已知可行(prebuild);ARM 待验。

## Open Questions

- **Q1(树莓派 ARM)**:better-sqlite3 是否有可用的 ARM(armv7/arm64)prebuild?无则需交叉/本机源码编译,工具链成本多大?——影响嵌入式最终形态;若端侧定 Node ≥24,可走内建路完全绕开,本问题降级。
- **Q2(observability 同批范围)**:`sqlite-loader.ts` 与 memory 的 `loadDatabaseSync` 是否抽成**单一共享 loader**(彻底单一权威),还是各自改同样逻辑?——倾向共享,实现期定。
- **Q3(依赖落点)**:`better-sqlite3` 放 `@chat-a/desktop`(宿主按需)还是 `@chat-a/memory`(就近)?——倾向 desktop(见 D3),最终随 build/打包实测定。
- **Q4(electron-builder 打包重建)**:`package` 流程下 better-sqlite3 是否被正确按目标平台重建并随包分发?——需真机打包验证。
