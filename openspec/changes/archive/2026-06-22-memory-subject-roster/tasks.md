## 1. 类型与配置(接缝先行，§3.1）

- [x] 1.1 在 `packages/memory/src/types.ts` 增 `MemorySubject = 'person' | 'agent' | 'shared'`；`MemoryInput` 增可选 `subject?`（默认 person）与 `personId?`（person/shared 默认主用户，agent 忽略）；`MemoryRecord` 增必带 `subject` 与 `personId: string | undefined`
- [x] 1.2 在 `types.ts` 增 `Person` 类型（`person_id`/`name`/`is_primary`/`status: 'primary'|'member'|'guest'`/`added_by: 'user'|'agent'`/`relationship_state?`/`voiceprint_ref?`），对齐 §5.3b；`MemoryStore` 公共方法签名保持向后兼容（不破坏现有调用方）
- [x] 1.3 在 `packages/memory/src/config.ts` 的 `MemoryConfig` 增 `primaryPersonId` 与 `primaryPersonName`（行为即配置，§3.2），给内置默认（如 `'primary'` + 默认名）；`DEFAULT_MEMORY_CONFIG`/`resolveMemoryConfig` 同步
- [x] 1.4 在 `packages/memory/src/config-loader.ts` 支持从环境变量覆盖主用户 id/name（沿用 `CHAT_A_MEMORY_*` 风格），缺省回落默认

## 2. SQLite 实现：schema 升版 + 迁移（数据迁移纪律，§3.2）

- [x] 2.1 在 `packages/memory/src/sqlite-store.ts` 把 `CURRENT_SCHEMA_VERSION` 从 2 升到 3
- [x] 2.2 新增 `MIGRATIONS[3]`：`CREATE TABLE IF NOT EXISTS people(person_id, name, is_primary, status, added_by, relationship_state, voiceprint_ref)`（列对齐 §5.3b，后四列可空）
- [x] 2.3 `MIGRATIONS[3]` 续：`ALTER TABLE memories ADD COLUMN subject TEXT`、`ADD COLUMN person_id TEXT`
- [x] 2.4 `MIGRATIONS[3]` 续：seed 主用户行（`is_primary=1, status='primary', added_by='user'`，name 取配置/默认），`ON CONFLICT(person_id) DO NOTHING`；id/name 由构造期注入而非硬编码进 SQL
- [x] 2.5 `MIGRATIONS[3]` 续：backfill 存量记忆 `UPDATE memories SET subject='person', person_id=<主用户id> WHERE subject IS NULL`（零数据丢失，§3.2）；全程在现有 `#migrate()` 单事务内，失败 ROLLBACK
- [x] 2.6 确认主用户 id/name 在 `#migrate()` 可访问（经 `SqliteMemoryStoreOptions.config` 解析后传入 MIGRATIONS 步骤）

## 3. SQLite 实现：写入与跨主语召回

- [x] 3.1 `addMemory` 落 `subject`（缺省 person）与 `person_id`（person/shared 缺省主用户、agent 写 NULL）；保持现有 ADD + `ON CONFLICT(normalized_text)` 去重语义
- [x] 3.2 `recall` 查询带回 `subject` 与 `person_id` 列，映射进 `MemoryRecord`；**移除任何按主语过滤**，一次覆盖 person+agent+shared（§5.3 末条）；排序维持近因/命中度
- [x] 3.3 读失败仍优雅降级为空、写失败不抛（沿用现有 `#onError`，§3.2）

## 4. InMemory 实现：同契约

- [x] 4.1 在 `packages/memory/src/in-memory-store.ts` 构造时 seed 主用户（镜像 people 语义，如内部 `Map<string, Person>`）
- [x] 4.2 `addMemory` 应用同样的 subject/personId 默认规则；`recall` 返回带 subject/personId 的记录、跨三类主语，与 SQLite 行为一致

## 5. 契约测试（确定性、无 LLM，§3.2）

- [x] 5.1 在 `packages/memory/test/contract.ts` 扩展共享契约：写入默认归 person；显式 agent/shared 主语写入与召回；person/shared 默认归属主用户、agent 记忆 personId 为空
- [x] 5.2 在共享契约增"一次召回跨三类主语"用例：同关键词命中 person+agent+shared，断言三类都返回且带正确 subject 标签
- [x] 5.3 在 `packages/memory/test/sqlite.test.ts` 增迁移用例：造一个升版前（v2/含无主语记忆）的库，打开后断言记忆全部 backfill 为 `subject='person'`+主用户 personId、零丢失，且 people 表存在主用户行（`is_primary=1, status='primary'`）
- [x] 5.4 在 `sqlite.test.ts` 复核既有"拒绝更高未知版本""跨重启恢复""KV"用例随 v3 仍通过（`CURRENT_SCHEMA_VERSION` 断言更新到 3）
- [x] 5.5 确认 InMemory 与 SQLite 共跑同一套契约（`runMemoryStoreContract`）覆盖主语/归属/跨主语召回

## 6. 收尾与验证

- [x] 6.1 运行 `pnpm -C packages/memory test`，全部契约（含主语/归属/迁移）通过
- [x] 6.2 类型检查 / lint 通过（严格 ESM，无 magic number，主用户身份全经配置）
- [x] 6.3 自检与 canonical 一致：§5.3 多主语、§5.3b 花名册结构就位、§5.8 仍只 ADD+去重、§3.2 零数据丢失；确认未越界实现 Non-goals（声纹识别/向量召回/用户组演化/多租户）
