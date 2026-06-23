## Context

`packages/memory` 已落地 A-MEM 式记忆关联网(承 §5.9 缺口①):写入时 `linkEntitiesAndEdges` 按"共享实体键(非主用户 person_id + 共现 token)"建/增无向加权邻接边(`memory_entities` / `memory_edges`,InMemory 镜像为 `#entityIndex` / `#edgeWeight` / `#adjacency`);召回时 `#spread(seedIds)` 从一阶命中种子沿邻接图做**固定 1–2 跳 BFS**,按 `hopDecay(hop, decay) = decay^hop` 几何衰减给"联想分",喂入混合召回的 `association` 信号路(走 §5.5/§5.9 缺口③ 的 `normalizeAndFuse` min-max 归一融合)。

canonical §5.10 B1 把此项标注为"实现中":**升级为 Personalized PageRank(HippoRAG 式重启随机游走)**——用稳态分自然表达"近 > 远、强连接 > 弱连接",取代固定跳数 + 单一几何衰减。

**现状基线**(实现期对齐用):
- `#spread(seedIds): Map<number, number>` 返回非种子记忆 id → 联想分;两实现共用同一规则(SQLite 走 SQL 取邻居 + JS,InMemory 走内存邻接表)。
- `association` 信号路在 `#finalizeCandidates` 里被联想带入的旁支用 `{present:true, value:联想分}` 填充,随后 `normalizeAndFuse` 做候选集尺度 min-max 归一加权融合(单一权威打分,§5.5)。
- `MemoryConfig` 已有 `associationMaxHops`(默认 2)、`associationHopDecay`(默认 0.5)。
- 邻接网为既有 schema(v6 `memory_entities` / `memory_edges`),`CURRENT_SCHEMA_VERSION` 当前 8。

承 canonical 章节:**§5.10 B1**(PPR 升级)、**§5.9**(认知保真度轴:联想缺口①)、**§5.5**(单一权威混合打分 + 非阻塞召回)、**§3.2**(行为即配置 + 单一权威纯函数防漂移)。

## Goals / Non-Goals

**Goals:**

- **PPR 稳态分作联想分**:从 query 命中一阶种子出发做重启随机游走 `r=(1−α)·M·r+α·s`,稳态 `r[node]` 即非种子记忆的联想分,替代 `hopDecay`。自然实现"近 > 远"(质量随跳数衰减)与"强连接 > 弱连接"(重边分得更多质量)。
- **沿用单一权威打分**:PPR 只改 `association` 那一路的取值方式,仍走既有 `normalizeAndFuse`,不引第二套漂移(§5.5)。
- **非阻塞**:PPR 只在 BFS 圈定的关联子图上跑(`associationMaxHops` 半径 + `pprMaxNodes` 节点封顶),幂迭代有上限(`pprIterations`)+ L1 收敛早停(`pprConvergenceEpsilon`),几千节点单位数毫秒,不开后台、不卡事件循环(§5.5 末「🔴 非阻塞召回」)。
- **行为即配置**:α / 迭代上限 / 收敛阈 / 子图节点上限全外置,无 magic number(§3.2)。
- **双实现同契约 + 确定性**:两 store 共用同一 `personalizedPageRank` 纯函数(节点按 id 升序遍历、无随机/时间),行为零漂移;退化优雅降级。

**Non-Goals:**

- **schema 变化** —— 复用既有 `memory_entities` / `memory_edges` 邻接网,`CURRENT_SCHEMA_VERSION` 不变、无迁移。
- **向量软边 / 跨 store 软关联** —— `recallByVector` 的相似度软边可作未来 PPR 边来源扩展,本期不做(注:仅留作未来扩展)。
- **关系亲密度(closeness)/ roster** —— 不碰(并行代理在改)。
- **离线巩固、情感共振、动态 α** —— 不在本期。

## Decisions

### 决策 1:`#spread` 重写为"BFS 圈定子图 → 子图内跑 PPR",而非全图 PPR

全图 PPR 在端侧记忆量增长时会变重且把不相关记忆也卷入迭代。改为:先从种子 BFS 在邻接连通子图上圈定 `associationMaxHops` 跳内、节点数封顶 `pprMaxNodes`(默认 2000)的工作子图(种子先入、近种子优先,超上限按 BFS 到达序截断),封顶后只保留两端都在子图节点集内的边(裁悬边),再在该封闭子图上跑 PPR。

- **`associationMaxHops` 语义变化**:从"按跳数硬截联想分"复用为"PPR 工作子图圈定半径"——跳数只决定"哪些节点进子图候选",联想分本身由 PPR 稳态分给出(2 跳外不进子图,但 2 跳内的强弱由 PPR 而非单一 `decay^hop` 决定)。设 0 仍关闭扩散、退化纯一阶召回(向后兼容)。
- **非阻塞硬约束**:子图封顶 + 迭代上限 + 收敛早停三重保证 PPR 不阻塞召回(§5.5)。

### 决策 2:PPR 转移矩阵按出度行归一;悬挂点质量回流种子(防泄漏)

`M` 由无向边共现 `weight` 构对称邻接,游走从 i 以 `weight(i,j)/Σ_k weight(i,k)`(出度 = 节点边权之和)走到邻居 j。**悬挂点**(出度 0,封闭子图内理论不应出现,但防御性处理)的质量回流到种子(等价 teleport),避免质量泄漏、保证 `Σr` 守恒。

- **强连接 > 弱连接** 由 `weight` 行归一自然得到:重边邻居分得更大转移概率 → 稳态分更高。
- **自环 / 非正权边忽略**:无向联想不计自指;非正权无意义(防归一除零/负质量)。

### 决策 3:种子均匀分布 `s`;迭代 `r=(1−α)·M·r+α·s`,r₀=s;L1 收敛早停

种子向量 `s` = 命中一阶记忆的均匀分布(和为 1),非种子 s=0。每步以 α 概率 teleport 回种子集(`pprAlpha` 默认 0.15,HippoRAG 惯用),`r` 初值取 s。相邻两次迭代秩向量 L1 变化 `Σ|rₜ−rₜ₋₁| < pprConvergenceEpsilon`(默认 1e-6)即提前收敛早停,否则迭代到 `pprIterations`(默认 15)上限。

- **α 影响**:α 越大越聚焦种子近邻(短程联想),越小越扩散(远程联想);外置可调。
- **近 > 远** 由随机游走质量随跳数自然递减得到(无需显式 `decay^hop`)。

### 决策 4:返回仅非种子节点稳态分;一阶命中不重复计入联想

种子(一阶命中)已在候选池,PPR 输出 MUST 排除种子(与原 `#spread` 一致),避免同一记忆既作命中又作联想被重复带入。两条互为邻居的种子各只出现一次。

### 决策 5:算法抽为 `config.ts` 纯函数 `personalizedPageRank(seedIds, edges, params)`,两实现共用

PPR 是确定性纯计算(给定 `seedIds` + `PprEdge[]` + `PprParams`),与"如何取邻居/边"(SQLite SQL vs InMemory 内存表)解耦。两 store 各自只负责 BFS 圈子图 + 收集 `PprEdge[]`,再调同一纯函数——杜绝两后端各写一遍迭代逻辑导致漂移(§3.2)。`associationHopDecay` 保留供向后兼容纯函数 `hopDecay`,召回路不再用。

## Risks / Trade-offs

- **子图封顶可能截断极远强关联**:`pprMaxNodes` 按 BFS 到达序(近种子优先)截断,远端关联可能不进子图。权衡:端侧非阻塞优先;默认 2000 对单用户量级足够;可经配置放大。
- **`associationMaxHops` 语义复用**:旧理解"硬跳数衰减"读者需注意现在它只圈定子图半径;已在 `config.ts` 注释文档化。
- **PPR vs hopDecay 排序差异**:升级后同一跳内邻居排序由边权(强连接)细分,非简单同分;契约 golden 锁住"近>远、强>弱、确定性"避免回归。

## Migration Plan

无 schema 迁移(复用既有邻接网,`CURRENT_SCHEMA_VERSION` 不变)。纯内部召回路升级,`MemoryStore` 公共方法签名不变,消费者无需改动。`associationMaxHops=0` 仍可关闭扩散退化为纯一阶召回。

## Open Questions

- 向量相似度软边作为 PPR 边来源(跨"无显式共享实体但语义近"的记忆建联想)——留作未来扩展(Non-goal)。
