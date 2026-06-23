# Tasks: 召回上下文窗口拼接（§5.5）

## 1. 类型与配置（接缝 + 行为即配置）
- [x] 1.1 `types.ts`：新增 `RecalledMemory`、`RecallWithContext`、`RecallContextOptions` 类型（纯加法）。
- [x] 1.2 `types.ts`：`MemoryStore` 接口新增 `recallWithContext(query, opts?): RecallWithContext`；**不动** `recall` 签名。
- [x] 1.3 `config.ts`：`MemoryConfig` 新增 `contextWindowSize`（默认 5，对齐 findings §4③），写入 `DEFAULT_MEMORY_CONFIG`。

## 2. 取窗纯函数（config.ts 单一权威，两实现共用）
- [x] 2.1 `anchorIndex(timestamps, memoryCreatedAtMs)`：时间戳就近锚点下标（同距取较早=较小下标；空数组 -1）。
- [x] 2.2 `windowRange(anchor, total, n)`：返回 `[start, end)` 半开区间，越界夹取；`anchor<0` 返回空区间。

## 3. 实现 recallWithContext（复用 recall，纯加法追加取窗）
- [x] 3.1 `in-memory-store.ts`：实现 `recallWithContext`——调 `recall` 拿命中与排序，按消息数组时序锚定+切窗，跨命中去重合并。
- [x] 3.2 `sqlite-store.ts`：实现 `recallWithContext`——调 `recall`，单次查询取全局消息时序（id+created_at+role+content），JS 层切窗+去重；读失败降级空（onError）。

## 4. 测试（契约 + golden，两实现同跑）
- [x] 4.1 `contract.ts`：取窗正确（前后各 N、含锚点、按时序）。
- [x] 4.2 `contract.ts`：跨命中去重（重叠窗口合并视图无重复、按全局时序）。
- [x] 4.3 `contract.ts`：边界——锚点在会话首/尾收窄、N=0 只含锚点、空库窗口为空。
- [x] 4.4 `contract.ts`：N 外置——默认取配置、per-call `windowSize` 覆盖生效。
- [x] 4.5 `contract.ts`：`recallWithContext` 命中顺序与 `recall` 一致；`recall` 向后兼容未变。

## 5. 验收
- [x] 5.1 `openspec validate context-window-recall --strict` 通过。
- [x] 5.2 worktree 根 `pnpm -r typecheck` 全绿（确认未改包不受影响）。
- [x] 5.3 `npx vitest run` 全量全绿。
