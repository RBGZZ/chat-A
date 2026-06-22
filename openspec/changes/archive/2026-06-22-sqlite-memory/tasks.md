## 1. 驱动验证与建包

- [x] 1.1 验证 `node:sqlite`（`DatabaseSync`）在本机 Node 24.16 可不带 flag 工作、能建表/读写/`PRAGMA journal_mode=WAL`、是否支持所需 SQL（写一次性 spike 脚本确认；不行则按 D1 切 `better-sqlite3`，记录结论）。
- [x] 1.2 新建 `packages/memory`（`@chat-a/memory`）：package.json（type module、exports、typecheck 脚本）、tsconfig（继承 base）、`src/index.ts`，并 `pnpm install` 链入 workspace。

## 2. MemoryStore 接缝与类型

- [x] 2.1 定义 `MemoryStore` 接口与类型（`StoredMessage` / `MemoryInput` / `MemoryRecord`；`ChatMessage` 复用 `@chat-a/protocol`），方法 `appendMessage / snapshot / addMemory / recall / close`（同步签名，承 D3）。
- [x] 2.2 定义记忆配置类型 + 默认值（召回上限、滑窗大小、去重规范化规则等，全外置，承 §3.2 行为即配置）。

## 3. 内存实现（迁移现有滑窗）

- [x] 3.1 实现 `InMemoryMemoryStore`（滑窗 + 关键词 token 召回 + ADD 去重），承接现有 `ConversationMemory` 语义。
- [x] 3.2 编写 `MemoryStore` 契约测试套件（写入/去重/召回/快照），对 `InMemoryMemoryStore` 跑通——此套件后续对 SQLite 实现复用（§3.1 同套契约验收）。

## 4. SQLite 实现

- [x] 4.1 实现 schema v1 建表（`memory_meta` / `messages` / `memories` + 索引 + WAL）与 `CURRENT_SCHEMA_VERSION`（D4）。
- [x] 4.2 实现迁移骨架：读版本 → `<CURRENT` 单事务顺序迁移且不丢数据 → `>CURRENT` 抛明确错误（D6）。
- [x] 4.3 实现 `SqliteMemoryStore`：`appendMessage`、`snapshot`（最近 N）、`addMemory`（`ON CONFLICT(normalized_text)` 去重增计数）、`recall`（token/LIKE + 排序 + 上限，D5）、`close`。
- [x] 4.4 用同一份契约测试（3.2）跑 `SqliteMemoryStore`（临时 DB 文件）。
- [x] 4.5 新增"重启恢复"测试：写入→close→以同路径新建实例→召回/快照仍在（spec: 跨重启恢复）。
- [x] 4.6 优雅降级：`recall`/`snapshot` 读失败捕获返回空 + 记录错误；`addMemory`/`appendMessage` 写失败不抛进调用方（§3.2），加对应测试。

## 5. 接线到回合

- [x] 5.1 `packages/runtime` 依赖 `@chat-a/memory`；`Conversation` 改为注入 `MemoryStore` 接口（默认 `InMemoryMemoryStore`，保持现有行为/测试不破）。
- [x] 5.2 回合中接入 `recall`：用用户输入关键词召回，召回上下文注入 prompt（召回失败走空上下文）；回合收尾 `appendMessage`（不阻塞流式首字）。
- [x] 5.3 cognition 的 `ConversationMemory` 迁移/再导出收尾，消除重复，更新引用。

## 6. 配置与客户端

- [x] 6.1 记忆实现选择 + DB 路径 + 召回/滑窗参数走配置（环境变量/配置加载，默认值保证既有 CLI/测试不破）。
- [x] 6.2 `packages/client` CLI 按配置装配 SQLite 实现；手动验证：对话→重启→小雪仍记得（对应验收 Rubric "跨会话记得"）。

## 7. 收尾验证

- [x] 7.1 全量 `pnpm typecheck` + `pnpm test` 通过（含新契约/重启/降级测试）。
- [x] 7.2 端到端冒烟：`start.bat` 走 SQLite 实现，跑通一次跨重启记忆，确认无原生编译/启动报错（树莓派友好性的 PC 侧代理验证）。
