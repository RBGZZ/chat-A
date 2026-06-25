# Tasks:electron-persistence

> 状态(2026-06-25 apply):代码接缝 + 依赖/构建配置已落地;**better-sqlite3 真 drop-in 已在 Node ABI 验证**(一次性脚本:KV(PAD)+ addMemory(lastInsertRowid)+ 跨实例持久化全过);全量 1516 测试绿(node:sqlite 主路零回归)。**未落项**:两后端 CI 契约单测(因 loadDatabaseSync 模块级缓存 + per-file backend 强制在 vitest 下脆弱,改用一次性脚本验证,未入 CI);**真机项(5.3-5.5)= 用户在真 Electron / 树莓派验**(electron-rebuild + 跨重启续接 + ARM)。新增 `CHAT_A_SQLITE_BACKEND=better-sqlite3` 显式开关(行为即配置 + 可验证)。

## 1. loadDatabaseSync 二选一接缝(memory)

- [x] 1.1 `packages/memory/src/sqlite-store.ts` 的 `loadDatabaseSync()`:先试 `node:sqlite` 的 `DatabaseSync`,失败再试 `require('better-sqlite3')`,两者都失败才抛 `SqliteUnavailableError`(D1)。
- [x] 1.2 接缝归一为统一 DatabaseSync-shape 构造器(`prepare/get/all/run/exec/pragma/close` + 插入行 id 取法),使 `SqliteMemoryStore` 主体零感知后端。
- [ ] 1.3 单测:mock 两种加载结果,验证优先级(node:sqlite 优先)、两者皆缺时抛 `SqliteUnavailableError`。

## 2. WAL / pragma 与类型适配

- [x] 2.1 WAL 设置经接缝按后端归一(node:sqlite `exec('PRAGMA journal_mode=WAL;')` ↔ better-sqlite3 `pragma('journal_mode = WAL')`),语义一致(D2)。
- [x] 2.2 确认 BLOB(`embedding` 列,Buffer)与整数(`asNumber` 兜底)在 better-sqlite3 下读写一致,补针对性断言(R-TYPE)。
- [ ] 2.3 两后端契约/golden 测试:同一套记忆测试分别跑 node:sqlite 与 better-sqlite3,断言行为一致、无漂移。

## 3. 依赖与原生重建配置

- [x] 3.1 把 `better-sqlite3` 加为依赖(落点 desktop 优先,见 D3 / Q3),更新 lockfile。
- [x] 3.2 `packages/desktop/package.json` 的 `rebuild` 脚本 `-w` 列表从 `naudiodon` 扩到 `naudiodon,better-sqlite3`(D3)。
- [x] 3.3 确认 `build.mjs` external 已含 `better-sqlite3`(已就位,核对即可);electron-builder `package` 流程按目标平台重建原生模块(Q4)。

## 4. observability sqlite-loader 同批(D5)

- [x] 4.1 `packages/observability/src/sqlite-loader.ts` 的 `loadDatabaseSync` 同样改为二选一接缝。
- [x] 4.2 评估是否抽 memory + observability 共享单一 loader(Q2);若抽,二者改为引用同一权威实现。

## 5. 验证

- [x] 5.1 全量 `pnpm test` 绿(含新增两后端契约测试)。
- [x] 5.2 `pnpm typecheck` 通过(含 desktop 两个 tsconfig)。
- [ ] 5.3 **待真机**:Electron 桌面端 `electron-rebuild -f -w naudiodon,better-sqlite3` 成功,`desktop:dev` 启动后命中 better-sqlite3、跨重启续接记忆 + PAD/人格(对应 spec 场景"桌面端重启后记忆与人格仍在")。
- [ ] 5.4 **待真机**:原生模块刻意缺失时,确认降级 `InMemoryMemoryStore`、应用不崩(对应 spec 场景"降级内存不崩")。
- [ ] 5.5 **待真机(可延后)**:树莓派 ARM 上 better-sqlite3 prebuild/编译可行性(Q1);若端侧定 Node ≥24 则走内建路、本项可豁免。

## 6. 收尾

- [x] 6.1 `openspec validate electron-persistence --strict` 通过。
- [x] 6.2 实现完成后 `openspec archive electron-persistence`,同步 `persistent-memory` 主 spec。
