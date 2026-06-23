## 1. 类型与接缝(接缝先行,§3.1)

- [x] 1.1 在 `packages/memory/src/types.ts` 的 `MemoryInput` 增可选 `openThread?: boolean`(默认 false),注释纯加法可选、向后兼容
- [x] 1.2 在 `types.ts` 的 `MemoryRecord` 增可选 `openThread?: boolean`(召回/查询返回时恒填充),注释同评分列风格
- [x] 1.3 在 `types.ts` 的 `MemoryStore` 接口增 `openThreads(limit?: number): readonly MemoryRecord[]` 与 `closeThread(id: number): void`,带契约注释(只返回未闭合、强度排序、巡检不强化、闭合幂等、降级不抛)

## 2. SQLite 实现:schema 升版 + 迁移(数据迁移纪律,§3.2)

- [x] 2.1 在 `packages/memory/src/sqlite-store.ts` 把 `CURRENT_SCHEMA_VERSION` 从 4 升到 5
- [x] 2.2 新增 `MIGRATIONS[5]`:`ALTER TABLE memories ADD COLUMN open_thread INTEGER`、`ADD COLUMN closed_at INTEGER`(复刻 v4 手法,幂等靠版本只跑一次)
- [x] 2.3 `MIGRATIONS[5]` 续:backfill 存量记忆 `UPDATE memories SET open_thread = 0 WHERE open_thread IS NULL`(零数据丢失,§3.2;closed_at 容 NULL 即未闭合)

## 3. SQLite 实现:写入 / 查询 / 闭合

- [x] 3.1 `addMemory` 落 `open_thread`(缺省 0)、`closed_at`(缺省 NULL);保持现有 ADD + `ON CONFLICT(normalized_text)` 去重语义
- [x] 3.2 `recall` 查询带回 `open_thread` 列并映射进 `MemoryRecord.openThread`(读列对 NULL 兜底为 false);不改命中集合与排序(向后兼容)
- [x] 3.3 实现 `openThreads(limit?)`:`WHERE open_thread = 1 AND closed_at IS NULL`,JS 层用 `recallScore(importance, decayFactor(...))` 排序、同分按 lastSeen/id 兜底;**不调用 `#reinforce`**(巡检不强化);读失败降级为空
- [x] 3.4 实现 `closeThread(id)`:`UPDATE memories SET closed_at = <now> WHERE id = ? AND closed_at IS NULL`(幂等);写失败不抛(`#onError`)

## 4. InMemory 实现:同契约

- [x] 4.1 在 `packages/memory/src/in-memory-store.ts` 的 `MutableRecord` 增 `openThread: boolean` 与 `closedAtMs: number | undefined`
- [x] 4.2 `addMemory` 应用同默认(`openThread ?? false`、`closedAtMs=undefined`);`recall` 返回带 `openThread`
- [x] 4.3 实现 `openThreads(limit?)`:过滤 `openThread && closedAtMs===undefined`,用同一强度公式排序、不强化;实现 `closeThread(id)`:置 `closedAtMs`(已闭合/未知 id 幂等)

## 5. 契约测试(确定性、无 LLM,§3.2)

- [x] 5.1 在 `packages/memory/test/contract.ts` 扩展共享契约:写入默认非未闭合(不进 openThreads);显式 `openThread=true` 写入后 `recall` 的 openThread=true 且进 openThreads
- [x] 5.2 增"openThreads 只返回未闭合 + 按强度排序 + 受上限约束"用例(注入时钟,golden 确定)
- [x] 5.3 增"openThreads 不触发检索即强化"用例:巡检后 importance/accessCount 未升
- [x] 5.4 增"closeThread 后退出 openThreads + 幂等(重复/未知 id 不抛)"用例
- [x] 5.5 在 `packages/memory/test/sqlite.test.ts` 增 v4→v5 迁移用例:造 v4 库(含存量记忆),打开后断言补 `open_thread=0`、零丢失、`CURRENT_SCHEMA_VERSION` 断言更新到 5;复核"拒绝更高未知版本"用例随 v5 仍通过

## 6. 收尾与验证

- [x] 6.1 worktree 根运行 `pnpm -r typecheck` 全绿(exactOptionalPropertyTypes 开,可选字段写入用条件展开)
- [x] 6.2 worktree 根运行 `npx vitest run` 全量全绿(含主语/评分/上下文窗口/未闭合话题/迁移)
- [x] 6.3 `openspec validate open-thread-marking --strict` 通过
- [x] 6.4 自检与 canonical 一致:§7#2 只做数据层不接 autonomy、§5.8 闭合是状态写非内容 update/delete、§3.2 零数据丢失 + 单一权威排序公式;确认未越界(不碰其它包)
