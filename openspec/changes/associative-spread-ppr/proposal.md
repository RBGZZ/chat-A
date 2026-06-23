## Why

长期伴侣的回忆是**联想式**的:提到"咖啡"会牵出"上次在那家店聊到的事",再牵出"那天的心情"——记忆按网状勾连一层层被激活,而非只命中字面关键词(§5.9 选"认知保真度轴":多线索、联想、情绪偏置、遗忘——联想扩散是最该补的缺口)。

`packages/memory` 已有 A-MEM 式记忆关联网(`memory_entities` / `memory_edges` 邻接表,承 §5.9 缺口①),召回时由 `#spread()` 做**固定 1–2 跳 BFS 联想扩散**,按跳数几何衰减(`hopDecay`)给"联想分"。但固定跳 BFS 有两个认知保真度缺陷:① **跳数硬截**——2 跳外的强关联记忆被一刀切掉,边界生硬;② **不分轻重**——同一跳内的所有邻居拿同样的衰减,无法体现"被多条边强连接的记忆比只搭一条边的更该被想起"。这正是 canonical §5.10 B1 标注为"实现中"的项:**升级为 Personalized PageRank(HippoRAG 式重启随机游走)**,用稳态分自然表达"近 > 远、强连接 > 弱连接"的多跳联想强度。

本 change 把 `#spread()` 从固定跳 BFS 升级为 **PPR**:从 query 命中的一阶种子出发做重启随机游走 `r = (1−α)·M·r + α·s`,稳态分 `r[node]` 即该记忆的联想分,替代原 `hopDecay` 喂入既有 `association` 信号路。**严格沿用 §5.5 单一权威打分**——PPR 稳态分只是 `association` 那一路的取值方式变了,仍走既有 `normalizeAndFuse` min-max 归一融合(与关键词/强度/情感/向量同框架),**不引第二套漂移**。

## What Changes

- **新增单一权威纯函数 `personalizedPageRank(seedIds, edges, params)`**(`config.ts`):在给定无向加权子图上做幂迭代 `r = (1−α)·M·r + α·s`——`M` 为共现 `weight` 行归一的对称转移矩阵、种子 `s` 为 query 命中一阶记忆的均匀分布、悬挂点质量回流种子(防泄漏)、L1 变化 `Σ|rₜ−rₜ₋₁|` 小于阈值即提前收敛早停。返回**每个非种子节点 → 稳态联想分**(种子本身不计入,与原 `#spread` 一致)。纯函数、确定性(节点按 id 升序遍历,无随机/时间),两 store 共用防漂移(§3.2)。
- **`#spread()` 重写为"BFS 圈定子图 → 子图内跑 PPR"**(`sqlite-store.ts` / `in-memory-store.ts`):先从种子 BFS 在邻接连通子图上圈定 `associationMaxHops` 跳内、节点数封顶 `pprMaxNodes` 的工作子图(近种子优先,封顶悬边裁掉),再在子图加权边上调 `personalizedPageRank`。**语义变化**:`associationMaxHops` 从"按跳数硬截联想分"复用为"PPR 工作子图圈定半径";联想分本身由 PPR 稳态分给出。两实现共用同一纯函数,行为一致。
- **行为即配置新增 PPR 参数**(`config.ts` `MemoryConfig` / `DEFAULT_MEMORY_CONFIG`):`pprAlpha`(重启系数,默认 0.15,HippoRAG 惯用)、`pprIterations`(幂迭代上限,默认 15)、`pprConvergenceEpsilon`(收敛阈,默认 1e-6)、`pprMaxNodes`(子图节点上限,默认 2000,端侧非阻塞)。全部外置,无 magic number(§3.2)。
- **`associationHopDecay` 保留为向后兼容**:升级后召回路不再用它(联想分改由 PPR 稳态分),仅留给纯函数 `hopDecay` 的几何衰减语义,不删以免破坏既有引用。
- **TDD golden 测试**:`scoring.test.ts` 增 `personalizedPageRank` 纯函数 golden(近>远、强连接>弱连接、确定性、退化空种子/空边/迭代≤0、自环/非正权边忽略、多种子对称等价);`contract.ts` 增双实现共享契约(PPR 近>远、强连接>弱连接、种子不重复计入联想、子图节点封顶生效)。

无 schema 变化(复用既有 `memory_entities` / `memory_edges` 邻接表,`CURRENT_SCHEMA_VERSION` 不变)。`MemoryStore` 公共方法签名不变(纯内部召回路升级,向后兼容)。`associationMaxHops` 设 0 仍关闭扩散、退化为纯一阶召回。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `persistent-memory`: 联想扩散召回从"固定跳数 BFS + 跳数几何衰减"升级为 **Personalized PageRank 重启随机游走**——稳态分作为 `association` 信号路的值融入既有单一权威混合打分;新增 α/迭代上限/收敛阈/子图节点上限四个外置配置;无 schema 变化、公共接口向后兼容。

## Impact

- **影响 canonical 章节**:§5.10 B1(联想扩散升级为 Personalized PageRank,HippoRAG 式随机游走,标注"实现中"→落地)、§5.9(认知保真度轴:联想缺口①)、§5.5(单一权威混合打分:PPR 稳态分只改 association 一路取值,仍走既有归一融合,不引第二套)、§3.2(行为即配置:α/迭代/收敛阈/子图上限全外置无 magic number;非阻塞硬约束:迭代有上限 + 子图封顶,几千节点单位数毫秒,不阻塞召回)。与权威设计一致,无冲突。
- **代码**:仅 `packages/memory`——`config.ts`(`personalizedPageRank` 纯函数 + `PprEdge`/`PprParams` 类型 + 四个 PPR 配置项)、`sqlite-store.ts`(`#spread` 重写为 BFS 圈子图 + 子图 PPR)、`in-memory-store.ts`(同契约)。不碰 roster/relationship_state/closeness、不碰其它包。
- **契约测试**:`test/contract.ts` 双实现共享 PPR 契约;`test/scoring.test.ts` 纯函数 golden;`test/in-memory.test.ts` / `test/sqlite.test.ts` 随升级仍通过。
- **延迟预算**:纯本地——BFS 仅在邻接连通子图上跑且节点封顶 `pprMaxNodes`(2000),PPR 同步幂迭代有上限(15)+ 收敛早停,几千节点单位数毫秒,不开后台、不卡事件循环(§5.5 末「🔴 非阻塞召回」)。无网络/LLM。
- **不涉及**:schema 变化(复用既有邻接表)、向量/语义召回、情感共振、关系亲密度(closeness)、离线巩固。仅改 `packages/memory`,不级联其它包。
