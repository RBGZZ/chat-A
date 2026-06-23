## Why

长期伴侣的记忆必须**有轻重、会淡忘、被想起就记得更牢**:重要的事(名字、过敏、根本设定)长期不忘,外围闲谈随时间淡去,被反复提及的记忆反而越记越牢(§5.5 / §5 三层认知记忆)。当前 `packages/memory` 的 `recall` 只按 `last_seen_at DESC, hits DESC` 排序——**没有时间衰减、没有重要性、没有检索即强化**:一条三个月前提过一次的小事和今天确认过的核心事实排在一起,违背 §5.5 的混合召回打分。

canonical §5.5 给出**单一权威衰减公式** `0.5^(days/H)`(H 默认 30,pinned 免衰,惰性 SQL 实时算)+ **检索即强化** `sal += k·(1-sal)`(命中升 importance)。本 change 在 P1 关键词召回基线上落地"时间衰减 + 重要性打分 + 检索即强化"三件套,schema 升到 v4。明确**只用一套公式**,不引入 OpenMemory 式后台/检索两套公式漂移(§5.5 风险表)。

## What Changes

- **schema v4 升版 + 迁移**:`memories` 增评分列 `importance REAL`(默认初值)、`access_count INTEGER`、`last_accessed INTEGER`,并预留 `pinned INTEGER`(核心记忆免衰)、`emotion_snapshot TEXT`(P2 情感共振预留)。沿用现有顺序 `MIGRATIONS` 骨架,`ALTER TABLE ADD COLUMN` 幂等,旧库补列、历史行给默认、零数据丢失(§3.2)。`CURRENT_SCHEMA_VERSION` 3→4。
- **惰性衰减召回**:`recall` 命中后按**单一权威公式** `0.5^(days/H)` 惰性实时算时间衰减(H 半衰期外置;pinned 免衰),与 importance 融合成一个 `score` 用于排序——不写回、不引第二套公式(§5.5)。
- **检索即强化**:`recall` 命中即升 `access_count`、按 `sal += k·(1-sal)`(k 外置)升 `importance`、更新 `last_accessed`("被想起→记得牢",§5.5)。
- **双实现同契约**:InMemory 与 SQLite 对衰减/强化/排序行为一致;扩展 `test/contract.ts` 并补衰减/强化/排序的 golden 确定性测试。

非破坏性:`MemoryRecord` 新增字段为**纯加法**(现有消费者只读 `text/kind/subject/hits/personId`);`MemoryStore` 公共方法签名不变。旧库经迁移自动补列给默认值,消费者无需改动。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `persistent-memory`: 记忆条目模型增评分列(`importance`/`access_count`/`last_accessed`/`pinned`);`recall` 改为按"单一权威衰减公式 + 重要性"融合打分排序,并在命中时做检索即强化;schema 升 v4 并迁移存量数据补列给默认。

## Impact

- **影响 canonical 章节**:§5.5(混合召回:时间衰减 + 重要性 + 检索即强化,单一权威公式)、§5(三层认知记忆/核心永不衰)、§3.2(数据迁移纪律 + 行为即配置:H/k/初值全外置无 magic number)。与权威设计一致,无冲突。
- **代码**:仅 `packages/memory`——`types.ts`(MemoryRecord 纯加法增字段)、`config.ts`(H/k/初值/上限等外置)、`config-loader.ts`(可选环境变量覆盖)、`sqlite-store.ts`(v4 迁移 + 惰性衰减 recall + 强化写回)、`in-memory-store.ts`(同契约)。
- **契约测试**:`test/contract.ts` 扩展(衰减排序 / 检索即强化 / pinned 免衰),InMemory 与 SQLite 共跑;`test/sqlite.test.ts` 增 v3→v4 迁移用例(补列、历史行给默认、零丢失)。
- **延迟预算**:纯本地 SQLite 读写,衰减为惰性实时算(召回时单次计算,不开后台任务),强化为命中行的小幅 UPDATE,无网络/LLM,延迟影响可忽略(§3.2)。
- **不涉及**:实时语音管线、向量/语义召回与情感共振重排(P2)、离线巩固的 update/delete(§5.8)、关联图传播(P2)。仅改 `packages/memory`,不级联其它包。
