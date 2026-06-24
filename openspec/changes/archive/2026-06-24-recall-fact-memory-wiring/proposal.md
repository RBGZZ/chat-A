## Why

`recall_fact` 是小雪"记得用户某件事"的事实查询接缝(§12.2),但当前它的事实查询回调 `FactLookup` **缺省恒返回 undefined**(`unavailableLookup`)——动作虽已注册并暴露给 tool-use,实际**从未接到真实记忆**:用户问"你记得我喜欢什么吗",模型只能永远回"想不起"。这与北极星(长期伴侣、有记忆)相悖。

`packages/memory` 已提供真实的同步 `MemoryStore.recall(query, limit, ...)` 关键词召回(带衰减/重要性/检索即强化)。本 change **只做接线**:把 `recall` 适配成 `recall_fact` 期望的同步 `FactLookup` 并在 client 装配处注入,让动作走真检索。**能力语义不变**(仍是"注入回调、不依赖 memory 包"的 §12.2 接缝),新增的是一个**可复用的适配器**与一处接线,而非新能力。

## What Changes

- **interaction 增适配器** `createMemoryFactLookup(store, { topN })`:对一个满足**最小结构契约** `FactRecallStore`(只需 `recall(query, limit?)`)的存储调用 `recall`,取前 topN 条非空文本拼接成一条事实串返回。**interaction 仍不 import `@chat-a/memory`**(用结构化类型保持 §3.1 解耦);memory 的 `MemoryStore` 天然满足该形状。
- **优雅降级(§3.2「永不崩永不哑」)**:检索为空 / 命中全为空白 / `recall` 抛错 → 返回 `undefined`,交由 `recall_fact` 表达"想不起"(**非崩溃、非 isError**)。
- **行为即配置**:topN、拼接分隔符外置为常量/选项(`DEFAULT_RECALL_FACT_TOP_N` 等),client 经 `CHAT_A_RECALL_FACT_TOP_N` 可覆盖,不写 magic number。
- **client 接线**:`packages/client/src/cli.ts` 用 `createMemoryFactLookup(mem.store, …)` 生成真 lookup,注入 `buildDefaultRegistry({ factLookup })`(文本/语音 REPL 共用同一注册表,一处接线两形态都生效)。

非破坏性:`FactLookup` 类型、`createRecallFactAction` 签名、`buildDefaultRegistry` 选项均不变;缺省(不注入)行为逐字一致(仍"暂不可用")。仅新增导出与一处装配。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `agent-actions`: 在既有"`recall_fact`(注入回调,不依赖 memory)"能力上,新增一个把真实召回存储适配为 `FactLookup` 的接缝(`createMemoryFactLookup`),并规定其 topN 截断与优雅降级语义。能力的核心约定(注入式、不依赖 memory 包、未命中非 isError)不变。

## Impact

- **影响 canonical 章节**:§12.2(事实查询接缝接真 memory)、§3.1(interaction 与 memory 解耦——用结构化契约而非包依赖)、§3.2(优雅降级"永不崩永不哑" + 行为即配置 topN 外置)、§5.5(经 `recall` 复用单一权威召回打分)。与权威设计一致,无冲突。
- **代码**:仅 `packages/interaction/src/actions/recall-fact.ts`(新增 `FactRecord`/`FactRecallStore`/`MemoryFactLookupOptions`/`createMemoryFactLookup` + 默认常量)与 `packages/client/src/cli.ts`(注入真 lookup)。`index.ts` 经既有 `export *` 自动透出新导出。
- **不涉及**:不改 `packages/memory` 实现(只读其公共 `recall` 接口的结构形状)、不碰 runtime/providers/persona/observability。不引入向量/语义检索路径(沿用 `recall` 关键词快路径;调用方若已配 embedder,后续可经 `recallHybrid` 扩展,本 change 不做)。
- **延迟预算**:纯本地同步 SQLite 读,单次 `recall`,无网络/LLM/异步,延迟影响可忽略;且 recall_fact 经 Agent loop 工具调用触发,不在首字热路径。
- **测试**:`packages/interaction/test/recall-fact-memory.test.ts`(新增):命中/多条 topN 截断/limit 透传/空结果降级/recall 抛错降级/空白文本/接入动作端到端,全确定性、无 LLM。
