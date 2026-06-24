## 1. 适配器接缝(interaction,不依赖 memory 包，§3.1）

- [x] 1.1 在 `packages/interaction/src/actions/recall-fact.ts` 增**最小结构契约** `FactRecord`（只 `text`）与 `FactRecallStore`（只 `recall(query, limit?)`），用结构化类型避免 import `@chat-a/memory`（memory 的 `MemoryRecord`/`MemoryStore` 天然满足）
- [x] 1.2 增**行为即配置**常量与选项：`DEFAULT_RECALL_FACT_TOP_N`、`DEFAULT_RECALL_FACT_JOINER`、`MemoryFactLookupOptions { topN?, joiner? }`（杜绝 magic number）
- [x] 1.3 实现 `createMemoryFactLookup(store, opts): FactLookup`：调 `store.recall(query, topN)`，取前 topN 条非空文本拼接返回；空/全空白/`recall` 抛错 → `undefined`（§3.2 优雅降级，不崩不哑）
- [x] 1.4 经既有 `export * from './actions/recall-fact'` 透出新导出（`index.ts` 无需改）

## 2. client 接线（文本/语音 REPL 共用同一注册表）

- [x] 2.1 `packages/client/src/cli.ts` import `createMemoryFactLookup`
- [x] 2.2 用 `createMemoryFactLookup(mem.store, …)` 生成真 lookup，注入 `buildDefaultRegistry({ factLookup })`
- [x] 2.3 topN 经 `CHAT_A_RECALL_FACT_TOP_N` 可覆盖（非法/缺省回落适配器默认），不写 magic number

## 3. 测试（TDD，确定性、无 LLM，§3.2）

- [x] 3.1 先写失败测试 `packages/interaction/test/recall-fact-memory.test.ts`：命中返回首条文本
- [x] 3.2 多条命中受 topN 约束、按召回顺序拼接；topN 透传给 `store.recall` 的 limit
- [x] 3.3 空结果 → undefined；`recall` 抛错 → 优雅降级 undefined；命中全空白 → undefined
- [x] 3.4 接入 `createRecallFactAction(createMemoryFactLookup(store))` 端到端：命中非 error、空结果降级为"想不起"非 error

## 4. 收尾与验证

- [x] 4.1 worktree 根 `pnpm -r typecheck` 全绿（interaction 仍不依赖 memory；client 接线类型通过）
- [x] 4.2 worktree 根 `npx vitest run` 全绿（新增适配器测试 + 既有 recall_fact/registry 测试不回归）
- [x] 4.3 自检与 canonical 一致：§12.2 接真 memory、§3.1 结构化解耦不引包依赖、§3.2 优雅降级 + topN 外置、§5.5 复用 `recall` 单一权威打分；确认只改 interaction 与 cli.ts，未越界碰 memory/runtime/providers/persona/observability 实现
