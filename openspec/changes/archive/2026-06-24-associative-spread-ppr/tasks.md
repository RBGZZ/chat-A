## 1. 配置与纯函数(行为即配置 + 单一权威先行,§3.1/§3.2)

- [x] 1.1 在 `packages/memory/src/config.ts` 的 `MemoryConfig` 增 PPR 参数:`pprAlpha`(重启系数,默认 0.15,HippoRAG 惯用)、`pprIterations`(幂迭代上限,默认 15)、`pprConvergenceEpsilon`(收敛阈,默认 1e-6)、`pprMaxNodes`(子图节点上限,默认 2000);`DEFAULT_MEMORY_CONFIG`/`resolveMemoryConfig` 同步,杜绝 magic number
- [x] 1.2 在 `config.ts` 文档化 `associationMaxHops` 的语义变化(从"按跳数硬截联想分"复用为"PPR 工作子图圈定半径";设 0 仍关闭扩散、退化纯一阶召回,向后兼容)
- [x] 1.3 在 `config.ts` 把 `associationHopDecay` 标注为"B1 PPR 升级后召回路不再用,仅留给纯函数 `hopDecay` 向后兼容";`hopDecay` 注释同步标注"召回路改由 `personalizedPageRank` 稳态分"
- [x] 1.4 在 `config.ts` 增类型 `PprEdge`(无向加权边 `{a,b,weight}`)与 `PprParams`(`Pick<MemoryConfig,'pprAlpha'|'pprIterations'|'pprConvergenceEpsilon'>`)
- [x] 1.5 在 `config.ts` 增**单一权威纯函数** `personalizedPageRank(seedIds, edges, params)`:节点全集按 id 升序固定遍历(确定性);构对称邻接 + 出度(边权之和)做行归一转移矩阵;种子均匀分布 `s`(和为 1);幂迭代 `r=(1−α)·M·r+α·s`(r₀=s),悬挂点(出度 0)质量回流种子(等价 teleport 防泄漏),L1 变化 `<pprConvergenceEpsilon` 提前收敛早停;自环/非正权边忽略;返回**仅非种子节点**的稳态分(种子已在候选池,不重复计入);退化(空种子/空边/`pprIterations<=0`)→ 空 Map

## 2. SQLite 实现:#spread 重写为 BFS 圈子图 + 子图 PPR

- [x] 2.1 在 `packages/memory/src/sqlite-store.ts` 把 `#spread(seedIds)` 重写:`associationMaxHops<=0` 或空种子 → 空(优雅降级,同现状)
- [x] 2.2 `#spread`:用无向邻居查询(`a=? 取 b UNION ALL b=? 取 a`)从种子 BFS 圈定 `associationMaxHops` 跳内、节点数封顶 `pprMaxNodes` 的连通子图(种子先入、近种子优先);沿途记录子图加权边(规范化 `min:max` 键去重),封顶后只保留两端都在子图节点集内的边(裁悬边)
- [x] 2.3 `#spread`:在子图加权边上调 `personalizedPageRank(seedIds, edges, this.#cfg)`,返回非种子记忆 id → PPR 稳态联想分;读失败 `#onError` 不抛、返回空(§3.2)
- [x] 2.4 `#finalizeCandidates`:用 `#spread` 返回的 PPR 稳态分作为 `association` 信号路的值(`{present:true, value: ppr}`),仍走既有 `normalizeAndFuse` min-max 归一融合(不另起第二套打分);联想带入的旁支按 kind 过滤一致、复算自身关键词命中(可能 0)

## 3. InMemory 实现:同契约

- [x] 3.1 在 `packages/memory/src/in-memory-store.ts` 把 `#spread(seedIds)` 重写为与 SQLite 同一权威语义:从 `#adjacency` BFS 圈定 `associationMaxHops` 跳内、封顶 `pprMaxNodes` 的子图(近种子优先)
- [x] 3.2 `#spread`:从 `#edgeWeight`(`min:max`→权重)收集两端都在子图节点集内的加权边,调同一 `personalizedPageRank` 纯函数,返回非种子 id → 稳态分
- [x] 3.3 `#finalizeCandidates`:与 SQLite 一致地把 PPR 稳态分喂入 `association` 信号路,走同一 `normalizeAndFuse`(两实现零漂移)

## 4. TDD golden(确定性、无 LLM,§3.2)

- [x] 4.1 在 `packages/memory/test/scoring.test.ts` 增 `personalizedPageRank` 纯函数 golden:**近 > 远**(链 seed–B–C,1 跳 B 稳态分 > 2 跳 C)
- [x] 4.2 增纯函数 golden:**强连接 > 弱连接**(同距邻居,边权重者稳态分更高)
- [x] 4.3 增纯函数 golden:**确定性**(同输入多次调用 entries 完全一致)
- [x] 4.4 增纯函数 golden:**退化优雅降级**(空种子 / 空边 / `pprIterations<=0` → 空 Map)
- [x] 4.5 增纯函数 golden:**自环 / 非正权边被忽略**(零权边节点不可达,不污染稳态分)
- [x] 4.6 增纯函数 golden:**多种子均匀分布**(对称图下两端等价节点稳态分相等)
- [x] 4.7 在 `packages/memory/test/contract.ts` 增双实现共享契约:**PPR 近 > 远**(1 跳邻居联想分高于 2 跳,排序更前)
- [x] 4.8 共享契约:**PPR 强连接 > 弱连接**(多共享键重边联想分高于单共享键)
- [x] 4.9 共享契约:**一阶命中不重复计入联想**(种子既是命中又互为邻居时,各只出现一次)
- [x] 4.10 共享契约:**子图节点封顶生效**(`pprMaxNodes` 小时,超上限的远端关联不被带入,端侧性能)
- [x] 4.11 复核 `in-memory.test.ts` / `sqlite.test.ts` 既有用例随升级仍通过(`CURRENT_SCHEMA_VERSION` 不变,无 schema 迁移)

## 5. 收尾与验证

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿(纯内部召回路升级,不级联其它包)
- [x] 5.2 worktree 根 `npx vitest run` 全绿(PPR 纯函数 golden + 双实现契约 + 既有用例)
- [x] 5.3 自检与 canonical 一致:§5.10 B1 PPR 升级、§5.9 联想缺口①、§5.5 单一权威混合打分(PPR 只改 association 一路取值,仍走既有归一融合不引第二套)、§3.2 α/迭代/收敛阈/子图上限全外置无 magic number + 非阻塞(迭代上限 + 子图封顶);确认未碰 schema / roster / closeness / 其它包
