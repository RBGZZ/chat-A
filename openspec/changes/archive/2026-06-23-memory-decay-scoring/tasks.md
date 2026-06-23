## 1. 类型与配置(接缝 + 行为即配置先行，§3.1/§3.2）

- [x] 1.1 在 `packages/memory/src/types.ts` 给 `MemoryRecord` **纯加法可选**增 `importance?`、`accessCount?`、`pinned?`（声明为可选以免现有构造 `MemoryRecord` 字面量的消费者级联改动——严格约束禁改 cognition/runtime；两实现 recall 恒填充，运行期必有值）
- [x] 1.2 在 `types.ts` 给 `MemoryInput` 增可选 `importance?: number`（省略用配置初值）与 `pinned?: boolean`（省略 false）；`MemoryStore` 公共方法签名保持不变（向后兼容）
- [x] 1.3 在 `packages/memory/src/config.ts` 的 `MemoryConfig` 增 `halfLifeDays`（H，默认 30）、`reinforceK`（k，默认 0.18）、`initialImportance`（初值，默认 0.5）；`DEFAULT_MEMORY_CONFIG`/`resolveMemoryConfig` 同步，杜绝 magic number
- [x] 1.4 在 `config.ts` 增**单一权威纯函数** + 常量：`MS_PER_DAY`、`decayFactor(lastSeenAtMs, now, pinned, cfg)`（pinned→1，否则 `0.5 ** (days/H)`，days 不为负）、`reinforceImportance(importance, cfg)`（`i + k·(1-i)`）、`recallScore(importance, decay)`（`importance × decay`）——两实现共用，防漂移
- [x] 1.5 在 `packages/memory/src/config-loader.ts` 支持可选环境变量覆盖（`CHAT_A_MEMORY_HALF_LIFE_DAYS`/`CHAT_A_MEMORY_REINFORCE_K`/`CHAT_A_MEMORY_INITIAL_IMPORTANCE`），缺省回落默认；用条件展开（exactOptionalPropertyTypes）

## 2. SQLite 实现：schema v4 升版 + 迁移（数据迁移纪律，§3.2）

- [x] 2.1 在 `packages/memory/src/sqlite-store.ts` 把 `CURRENT_SCHEMA_VERSION` 从 3 升到 4
- [x] 2.2 新增 `MIGRATIONS[4]`：`ALTER TABLE memories ADD COLUMN importance REAL` / `access_count INTEGER` / `last_accessed INTEGER` / `pinned INTEGER` / `emotion_snapshot TEXT`（沿用 v3 ALTER 手法，幂等靠"只在 schema_version<4 跑一次"）
- [x] 2.3 `MIGRATIONS[4]` 续：backfill 历史行 `UPDATE memories SET importance=<配置初值>, access_count=0, pinned=0 WHERE importance IS NULL`（零数据丢失，§3.2）；初值经 `MigrationContext` 注入而非硬编码
- [x] 2.4 把 `initialImportance` 加进 `MigrationContext`（沿用 v3 经 ctx 注入主用户的手法），在 `#migrate()` 构造 ctx 时填入

## 3. SQLite 实现：惰性衰减召回 + 检索即强化

- [x] 3.1 `addMemory` 写入时落 `importance`（缺省配置初值）、`access_count=0`、`pinned`（缺省 0）、`last_accessed`（=createdAt）；保持 ADD + `ON CONFLICT(normalized_text)` 去重语义
- [x] 3.2 `recall`：SQL 仍 LIKE 过滤候选并取回评分列；在 JS 层用 `recallScore(importance, decayFactor(...))` 排序（次级键 hits DESC, id DESC），截断到 limit；读列时对 importance/access_count/pinned/last_accessed 的 NULL 兜底（初值/0/false/last_seen_at）
- [x] 3.3 检索即强化：对**返回的 top-N** 命中行执行 `UPDATE memories SET access_count=access_count+1, importance=<reinforce>, last_accessed=<now> WHERE id IN (...)`；在排序+截断**之后**施加（本次返回用强化前值）；失败走 `#onError` 不抛（§3.2）
- [x] 3.4 `MemoryRecord` 映射带回 `importance`/`accessCount`/`pinned`（pinned 由 INTEGER→boolean），与现有 subject/personId 字段并存

## 4. InMemory 实现：同契约

- [x] 4.1 在 `packages/memory/src/in-memory-store.ts` 的内部记录结构增 `importance`/`accessCount`/`pinned`/`lastAccessedAtMs`；`addMemory` 应用同样默认规则
- [x] 4.2 `recall` 用同一组 `config.ts` 纯函数算衰减/得分排序、命中即强化（改内部 record 的 importance/accessCount/lastAccessed），与 SQLite 行为一致；返回带新字段

## 5. 契约测试 + golden（确定性、无 LLM，§3.2）

- [x] 5.1 在 `packages/memory/test/contract.ts` 扩展共享契约：注入时钟，写入两条等重要性记忆但 last_seen 相差远超半衰期 → 断言新近者排前（时间衰减 golden）
- [x] 5.2 共享契约增检索即强化用例：召回命中一次后再召回，断言 importance 上升、access_count 增加、排序更稳（强化 golden）
- [x] 5.3 共享契约增 pinned 免衰用例：pinned 记忆即使很旧也不被时间压低（需经 store 写入 pinned；用 `addMemory({ pinned: true })`）
- [x] 5.4 共享契约增融合排序用例：构造 importance × decay 不同的多条，断言按 score 降序、得分相同按 hits/id 兜底（两实现一致）
- [x] 5.5 在 `packages/memory/test/sqlite.test.ts` 增 v3→v4 迁移用例：造一个 v3 库（含记忆、无评分列、schema_version=3），打开后断言历史记忆补默认 importance/access_count=0/pinned=0、零丢失、schema 升到 4、可正常召回
- [x] 5.6 复核 `sqlite.test.ts` 既有"拒绝更高未知版本""跨重启恢复""KV""降级"用例随 v4 仍通过（`CURRENT_SCHEMA_VERSION` 断言更新到 4）

## 6. 收尾与验证

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿（纯加法字段不级联改其它包）
- [x] 6.2 worktree 根 `npx vitest run` 全绿（衰减/强化/排序 golden + v3→v4 迁移 + 双实现契约）
- [x] 6.3 自检与 canonical 一致：§5.5 单一权威衰减公式 + 检索即强化、§5 核心 pinned 免衰、§3.2 H/k/初值全外置无 magic number + 零数据丢失；确认未越界实现 Non-goals（向量/情感共振/H 随热度变/关联图传播/后台衰减写回）
