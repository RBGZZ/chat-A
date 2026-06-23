## Context

当前 `packages/memory` 的 `recall`(见 `sqlite-store.ts` / `in-memory-store.ts`)只按 `last_seen_at DESC, hits DESC, id DESC` 排序——**无时间衰减、无重要性、无检索即强化**。canonical §5.5 要求混合召回打分含"时间衰减 + 重要性",并明确**单一权威衰减公式** `0.5^(days/H)`(H 默认 30,pinned 免衰,惰性 SQL 实时算),以及**检索即强化** `sal += k·(1-sal)`(命中升 importance,"被想起→记得牢")。§5 三层认知记忆要求**核心/pinned 永不衰减**。

**现状基线**(实现期对齐用):
- `MemoryStore` 接缝(`types.ts`):`addMemory(rec: MemoryInput)` / `recall(query, limit) → readonly MemoryRecord[]` + snapshot/messagesForSession/KV/close,同步签名。`MemoryRecord` 现有字段:`id/text/kind/createdAtMs/lastSeenAtMs/hits/subject/personId`。
- `SqliteMemoryStore`(`sqlite-store.ts`):单文件真相源;`memory_meta.schema_version` + 顺序 `MIGRATIONS` 骨架,`CURRENT_SCHEMA_VERSION = 3`;写路径 ADD + `ON CONFLICT(normalized_text)` 去重;recall 走 `normalized_text LIKE` 多 token OR,排序 `last_seen_at DESC, hits DESC, id DESC`。
- `InMemoryMemoryStore`(`in-memory-store.ts`):同契约,无持久化;recall 用 JS `sort`。
- 配置(`config.ts`):`MemoryConfig` 行为全外置(`recallLimit` 等),`now` 时钟可注入(确定性测试)。
- 契约测试 `test/contract.ts` 由 InMemory 与 SQLite 共跑(`test/in-memory.test.ts` / `test/sqlite.test.ts`)。

承 canonical 章节:**§5.5**(混合召回:时间衰减 + 重要性 + 检索即强化,单一权威公式)、**§5**(三层认知:核心/pinned 永不衰减)、**§3.2**(数据迁移纪律 + 行为即配置:H/k/初值全外置,杜绝 magic number,单一权威公式)。

## Goals / Non-Goals

**Goals:**

- **时间衰减**(惰性实时算):`recall` 命中后按**单一权威公式** `decay = 0.5^(days/H)` 计算,`days = (now - lastSeenAtMs) / 一天毫秒`;H 为半衰期(外置,默认 30 天);`pinned` 记忆免衰(`decay = 1`)。惰性算,不开后台任务、不写回衰减值(避开 OpenMemory/Memoripy 两套公式 + 复利写回漂移)。
- **重要性打分**:`memories` 增 `importance REAL`(默认初值外置),融合进排序得分:`score = importance × decay`(单一权威融合式,见决策 2)。
- **检索即强化**:`recall` 命中即(a)`access_count += 1`;(b)`importance := importance + k·(1 - importance)`(k 外置,salience 趋近 1 但不超);(c)`last_accessed := now`。这是**唯一**会写回 importance 的地方(热路径轻量 UPDATE)。
- **schema v4 迁移**:`memories` 增 `importance`/`access_count`/`last_accessed`/`pinned`/`emotion_snapshot` 列;`ALTER TABLE ADD COLUMN` 幂等,旧库历史行经迁移给默认(`importance`=初值、`access_count`=0、`pinned`=0),零数据丢失(§3.2)。
- **双实现同契约**:InMemory 与 SQLite 衰减/强化/排序行为一致;扩展 `test/contract.ts` + golden 确定性测试。

**Non-Goals:**

- **向量/语义召回、情感共振 5×5 矩阵重排、`boosted_sim`** —— P2;本期 recall 维持关键词级,得分只含 importance × 时间衰减。`emotion_snapshot` 列仅就位不参与打分。
- **H 随 salience/热度变(hot/warm/cold 分层)** —— §5.5 标注的 🆕 增强;本期保持**最简单的单一公式**(固定 H),把"salience 进分母"留待 P2,避免过早引入复杂度。importance 的影响通过乘性 `× decay` 体现而非改 H。
- **关联图轻传播到邻居("被联想到→记得牢")** —— P2,需关联图结构,本期无。
- **离线巩固的 update/delete/discard、衰减遗忘的物理删除** —— 仍走 §5.8 离线巩固;本期热路径只 ADD + 去重 + 检索即强化,衰减只影响排序不删数据。
- **后台衰减写回任务** —— 明确不做;衰减惰性实时算(§5.5)。

## Decisions

### 决策 1:衰减用单一权威公式 `0.5^(days/H)`,惰性实时算、不写回、pinned 免衰

`decay(record, now) = record.pinned ? 1 : 0.5 ** (days / H)`,其中 `days = max(0, (now - lastSeenAtMs) / MS_PER_DAY)`,`H` 来自 `MemoryConfig.halfLifeDays`(默认 30,§5.5)。

- **为什么 `lastSeenAtMs` 作为衰减基准**:`last_seen_at` 已是"最近一次被提及/写入"的时间戳(ADD 去重时更新),语义上等价于记忆的新鲜度。检索即强化更新的是 `last_accessed`(访问审计)与 `importance`(强化),**不**改 `last_seen_at`——保持衰减基准只反映"内容层面被提及"而非"被召回扫描到",避免一次查询把所有命中项的衰减都重置(那会让衰减失效)。
- **为什么惰性、不写回**:§5.5 明确"惰性 SQL 实时算";写回衰减值会引入复利漂移(Memoripy 坑)+ 后台任务延迟。SQLite 侧在 SQL 里 `ORDER BY` 直接用表达式算;InMemory 侧在 `sort` 比较器里算。两边用**同一个纯函数语义**(决策 4)。
- **pinned 免衰**(§5:核心记忆永不衰减):`pinned=1` 的记忆 `decay=1`,恒不随时间淡去。P1 不提供 pin 的写入 API(列就位、默认 0),pin 由未来巩固/核心标注写,本期通过直接置列在测试中验证免衰行为。

### 决策 2:融合得分 `score = importance × decay`(单一权威融合式)

排序键 `score = importance × decay`:重要性高的衰减慢(乘性放大),外围低重要性记忆随时间快速沉底。命中度 `hits`、`id` 作为**次级**确定性 tiebreaker(保证 golden 可复现)。

- **为什么乘性而非加性**:§5.5 给的是"时间衰减 + 重要性"作为打分**分量**,P1 无向量/FTS 分,只有这两项;乘性让"重要且新鲜"双高者胜出,且 `importance` 天然在 `[初值, 1]`、`decay` 在 `(0,1]`,乘积落在可比区间,无需再归一(避免引第二套归一公式漂移)。pinned 时 `decay=1`,`score=importance` 恒高。
- **替代(弃)**:`α·importance + β·decay` 加权和——多两个权重旋钮、且需对量纲归一,P1 无收益反增漂移面。留 P2 接入向量分时再评估加权融合。
- **确定性**:同 `score` 时按 `hits DESC, id DESC` 兜底(与现有 tiebreaker 一致),保证两实现 + golden 排序完全确定。

### 决策 3:检索即强化用 `importance += k·(1 - importance)`,是唯一写回 importance 处

命中记忆:`access_count += 1`;`importance := importance + k·(1 - importance)`(`k = MemoryConfig.reinforceK`,默认 0.18,§5.5 OpenMemory `sal+=0.18·(1-sal)`);`last_accessed := now`。

- **为什么这个形式**:`importance` 单调趋近 1 但永不超过(`1-importance` 随接近 1 而衰减增量),天然封顶、无需 clamp;§5.5 直接给的公式,单一权威。
- **强化在排序计算之后施加**:`recall` 先按"读到的旧 importance"算 score 排序、截断到 limit,**再**对返回的(命中且入选的)记录施加强化——保证"本次返回的排序"用的是强化前的值(确定性),强化只影响**后续**召回。SQLite 用一次 `UPDATE ... WHERE id IN (返回的 id)`;InMemory 直接改 record。
- **写失败不抛**:强化的 UPDATE 失败沿用 `#onError` 优雅降级(§3.2),不拖垮召回返回。
- **only 命中且入选**:只强化实际返回给上层的 top-N(被真正"想起"的),不强化所有 LIKE 命中行——更贴合"被想起→记得牢"语义且 UPDATE 量小。

### 决策 4:衰减/强化逻辑抽为 `config.ts` 纯函数,两实现共用(防漂移)

在 `config.ts` 增单一权威纯函数:`decayFactor(lastSeenAtMs, now, pinned, cfg)`、`reinforceImportance(importance, cfg)`、`recallScore(importance, decay)` + 常量 `MS_PER_DAY`。SQLite 与 InMemory 都调它(SQLite 取回行后在 JS 里算 score 排序,而非把公式写进 SQL——避免 SQL 表达式与 JS 公式两处各写一遍漂移;LIKE 过滤仍在 SQL,只是排序在 JS 层用统一公式)。

- **为什么排序移到 JS 层**:`0.5^(x)` 在 SQLite 需 `pow()`(扩展函数,未必可用)或 `exp/ln`;把公式收敛到一个 TS 函数,两后端零漂移(§3.2 单一权威公式),代价是 SQLite 召回先取候选行再 JS 排序——P1 数据量小、纯本地,延迟可忽略。为防候选集过大,SQL 仍先 LIKE 过滤;排序+截断在 JS。
- **替代(弃)**:SQLite 在 SQL 里算衰减、InMemory 在 JS 里算——两份公式必漂移,违背 §5.5/§3.2。

### 决策 5:`MemoryRecord` 纯加法增字段,消费者零改动

`MemoryRecord` 增 `importance: number`、`accessCount: number`(及 `pinned: boolean`)为**纯加法**;现有消费者只读 `text/kind/subject/hits/personId`,新增字段不影响它们,全仓 `pnpm -r typecheck` 不级联。`MemoryInput` 可选增 `importance?`/`pinned?`(省略用默认初值/false),写入方无需改动。

- **exactOptionalPropertyTypes**:可选字段在对象字面量按条件展开(沿用 config-loader 既有手法),不写 `undefined`。

## Migration Plan

v3 → v4(`MIGRATIONS[4]`,沿用现有单事务 + 失败 ROLLBACK 骨架):

1. `ALTER TABLE memories ADD COLUMN importance REAL`(SQLite 加列默认 NULL;迁移内立即 backfill)。
2. `ALTER TABLE memories ADD COLUMN access_count INTEGER`。
3. `ALTER TABLE memories ADD COLUMN last_accessed INTEGER`。
4. `ALTER TABLE memories ADD COLUMN pinned INTEGER`(预留,核心免衰)。
5. `ALTER TABLE memories ADD COLUMN emotion_snapshot TEXT`(预留,P2 情感共振)。
6. backfill 历史行:`UPDATE memories SET importance = <初值>, access_count = 0, pinned = 0 WHERE importance IS NULL`(零丢失;`last_accessed`/`emotion_snapshot` 容 NULL,读取侧兜底)。

- **幂等**:`ALTER ADD COLUMN` 不带 IF NOT EXISTS(SQLite 不支持列级 IF NOT EXISTS),幂等性靠"v4 迁移只在 `schema_version < 4` 时跑一次"(与现有 v3 ALTER 手法完全一致,见 `MIGRATIONS[3]`)。
- **读取侧兜底**:recall 映射时对 `importance` NULL 兜底初值、`access_count` NULL 兜底 0、`pinned` NULL 兜底 0、`last_accessed` NULL 兜底 `last_seen_at`——稳健应对任何残留 NULL(§3.2)。
- **初值来自配置**:`MemoryConfig.initialImportance`(默认 0.5,行为即配置)经构造期传入,不硬编码进迁移 SQL 字面量(沿用 v3 经 ctx 注入主用户的手法,这里初值是纯标量可直接绑参)。

## Risks / Trade-offs

- **SQLite 排序移到 JS 层**:候选集大时多取行。缓解:SQL 先 LIKE 过滤缩小候选;P1 本地小库,延迟可忽略;若 P2 数据量增,可在 SQL 内用 `last_seen_at` 粗排预截断再 JS 精排(留接缝)。
- **检索即强化改写库**:`recall` 不再是纯读。缓解:UPDATE 只针对返回的 top-N、失败优雅降级不抛、不阻塞返回;"读会写"是 §5.5 明确设计(被想起→记得牢),非副作用滥用。
- **单一融合式 `importance × decay` 是 P1 简化**:未含向量/FTS/情感分。已在 Non-Goals 标注,P2 接入时在同一个 `recallScore` 函数内扩展(单一权威点),不新增第二套。
