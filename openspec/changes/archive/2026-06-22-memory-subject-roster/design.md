## Context

长期陪伴最致命的失败是**自相矛盾**:记不清"这件事是用户说的，还是小雪自己确立过的"，或把访客的事安到主用户头上。当前 `packages/memory` 的记忆条目（`MemoryInput`/`MemoryRecord`，见 `types.ts`）**无主语、无人物归属**——既分不清 person/agent/shared，也没有"这是谁"的 `person_id`。

canonical §5.3 要求记忆带 `subject ∈ {person, agent, shared}`；§5.3b 要求以**人物花名册（people roster）**为中心建模，"始终有一个主用户、可认识多人、未来可扩展为用户组 + Agent 自主纳入成员"。本 change 在 P1 阶段把这套 schema 一次性落地——即使现在只有 1 个主用户，结构也必须从一开始就支持多主语 + person_id，否则未来做多人对话（P3）、用户组（P4）时要付出"长期记忆迁移"的高昂代价，而长期记忆/关系数据正是本项目全部价值所在（§3.2 数据即关系）。

**现状基线**（实现期对齐用）：
- `MemoryStore` 接缝（`types.ts`）：`addMemory(rec: MemoryInput)` / `recall(query, limit) → MemoryRecord[]` + snapshot/KV/close，同步签名。
- `SqliteMemoryStore`（`sqlite-store.ts`）：单文件真相源；`memory_meta.schema_version` + 顺序 `MIGRATIONS` 骨架，`CURRENT_SCHEMA_VERSION = 2`；写路径 ADD + `ON CONFLICT(normalized_text)` 去重；recall 走 `normalized_text LIKE` 多 token OR。
- `InMemoryMemoryStore`（`in-memory-store.ts`）：同契约，无持久化。
- 契约测试 `test/contract.ts` 由 InMemory 与 SQLite 共跑（`test/in-memory.test.ts` / `test/sqlite.test.ts`）。

承 canonical 章节：**§5.3**（多主语 person/agent/shared）、**§5.3b**（人物花名册 + 单主用户→多人→用户组可扩展）、**§5.8**（写路径 ADD + 去重，update/delete 移离线）、**§3.2**（数据迁移纪律：schema 版本化 + 迁移 + 零数据丢失）。

## Goals / Non-Goals

**Goals:**

- 记忆条目带主语 `subject ∈ {person, agent, shared}`：`MemoryInput.subject` 可选（默认 `'person'`），`MemoryRecord.subject` 必带（召回结果总携带主语标签）。
- 记忆挂人物 `personId`：`person`/`shared` 主语关联人物花名册中的某人（P1 恒为主用户）；`agent` 主语不关联人（可空）。
- 新增 **people 花名册表** `people(person_id, name, is_primary, status, added_by, relationship_state, voiceprint_ref)`；P1 只 seed 1 个主用户（`is_primary=1, status='primary', added_by='user'`），其余字段结构就位但可空。
- **跨主语召回**：一次 `recall` 覆盖 person + agent + shared，返回的每条记录带 `subject`（也带 `personId`），让上层一次拿到"关于当前说话人 + 关于自己确立过的 + 共同经历"，防自相矛盾（§5.3 末条）。P1 仍是关键词级，不引入向量。
- **schema 升版 + 迁移**：沿用现有版本化骨架升一版，把存量记忆 backfill 为 `subject='person' + personId=主用户`，并插入主用户 people 行；零数据丢失（§3.2）。
- **契约测试扩展**：同一套契约覆盖 InMemory 与 SQLite——主语写入 / 跨主语召回 / 迁移后存量归属主用户；确定性、无 LLM。

**Non-Goals:**

- **说话人识别**（声纹 / diarization）—— P3 大脑侧能力，本期只建 `person_id` + `voiceprint_ref` 结构，不做任何识别。
- **向量 / 语义召回** —— P2，本期 recall 维持关键词级（FTS / LIKE）。
- **用户组的多关系演化、Agent 自主纳入访客** —— P4，本期只让 `status`/`added_by`/`relationship_state` 字段就位，不实现提升逻辑。
- **多租户**（多个互相独立的主用户各一套伴侣）—— 后续大版本，明确不在范围。
- **离线调和 / update / delete** —— 仍走 §5.8 离线巩固，本期热路径只 ADD + 去重。

## Decisions

### 决策 1：`subject` 与 `personId` 都进 `MemoryInput`/`MemoryRecord`，输入侧默认 `person`/主用户

`MemoryInput` 增 `subject?: MemorySubject`（默认 `'person'`）与 `personId?: string`（默认主用户；`agent` 主语忽略此字段）；`MemoryRecord` 增 `subject: MemorySubject`（必带）与 `personId: string | undefined`（agent 为 `undefined`）。

- **为什么默认 `person` + 主用户**：P1 绝大多数写入来自主用户对话，默认值让现有 cognition/runtime 调用方**无需改动**（向后兼容，承 proposal"非破坏性"）。Agent 自我事实、shared 经历由写入方显式标 `subject`。
- **替代方案（弃）**：用单独的 `kind` 字段编码主语——污染语义（`kind` 是记忆种类如"偏好/事实"，与主语正交），且无法承载 `personId`。

### 决策 2：people 花名册独立成表，记忆经 `person_id` 外键关联（不外键约束，软关联）

新增 `people` 表，列对齐 §5.3b：
- `person_id TEXT PRIMARY KEY`（稳定标识，P1 主用户用配置/默认派生的固定 id）
- `name TEXT NOT NULL`（主用户名从 config/默认读，行为即配置）
- `is_primary INTEGER NOT NULL DEFAULT 0`
- `status TEXT NOT NULL`（`'primary' | 'member' | 'guest'`）
- `added_by TEXT NOT NULL`（`'user' | 'agent'`）
- `relationship_state TEXT`（P1 可空，预留亲密度/IPC 轨迹的 JSON）
- `voiceprint_ref TEXT`（P1 可空，预留 P3 声纹引用）

`memories.person_id` 不加 SQL 外键约束（软关联），原因：(a) `agent` 主语的记忆 `person_id` 为 NULL，外键会增复杂度；(b) 迁移/seed 顺序与回放更简单；(c) 归属正确性由契约测试守，而非 DB 约束。InMemory 实现用一个 `Map<string, Person>` 镜像同语义。

- **替代方案（弃）**：把人物信息塞进 `kv_state`——无法表达"多人"与按人查询，违背 §5.3b"以人为中心"。

### 决策 3：跨主语召回返回扁平 `MemoryRecord[]`，每条自带 `subject`/`personId`（而非分组结构）

`recall(query, limit)` 签名**不变**，仍返回 `readonly MemoryRecord[]`；变化是每条记录现在带 `subject` 与 `personId`，且查询**不再按主语过滤**——一次扫过 person + agent + shared。上层若需分组，自行按 `record.subject` 桶化。

- **为什么扁平而非 `{person, agent, shared}` 分组返回**：(a) 保持 `MemoryStore` 接缝签名稳定，爆炸半径最小（§3.1）；(b) 排序是跨主语统一的近因/命中度序，分组会割裂排序；(c) "防自相矛盾"的本质是**让 agent 自述与 person 事实在同一召回里同时出现**，扁平列表天然满足，上层注入 prompt 时再按 subject 打标即可。
- **P1 的 person 维度**：recall 暂不按"当前说话人 personId"过滤（P1 只有主用户，person 记忆全归主用户）。预留：未来多人时可加可选 `personId` 过滤参数，本期不引入以免 over-engineer。
- **替代方案（弃）**：新增 `recallBySubject()` 方法——徒增接缝面，P1 无消费者。

### 决策 4：schema 升至 v3，单条迁移完成"建表 + 加列 + backfill + seed"，全程一个事务

`CURRENT_SCHEMA_VERSION: 2 → 3`，新增 `MIGRATIONS[3]`：
1. `CREATE TABLE IF NOT EXISTS people(...)`。
2. `ALTER TABLE memories ADD COLUMN subject TEXT`；`ADD COLUMN person_id TEXT`（SQLite 加列默认 NULL，幂等性靠 v3 只跑一次保证）。
3. **seed 主用户**：`INSERT ... INTO people` 一行 `(person_id=<主用户id>, name=<config/默认>, is_primary=1, status='primary', added_by='user')`，`ON CONFLICT(person_id) DO NOTHING`。
4. **backfill 存量记忆**：`UPDATE memories SET subject='person', person_id=<主用户id> WHERE subject IS NULL`——把所有旧记忆归为主用户的 person 记忆，零丢失（§3.2）。

迁移沿用现有骨架：跑在 `#migrate()` 的 `BEGIN/COMMIT` 事务里，失败 `ROLLBACK`；版本号经 `memory_meta.schema_version` 推进；高于代码支持仍报错。主用户 id/name 通过 `SqliteMemoryStoreOptions` / `MemoryConfig` 注入（缺省用内置默认），保证确定性测试可固定。

- **为什么 backfill 而非置默认列值**：`ADD COLUMN ... DEFAULT 'person'` 只影响新行不回填旧行的写法在某些场景不可靠，显式 `UPDATE ... WHERE subject IS NULL` 语义清晰、可断言、可回放。
- **InMemory 同契约**：InMemory 无 schema 概念，但构造时同样 seed 主用户、新写入应用同样默认值，使两实现对"主语 + 归属"行为一致。

### 决策 5：主用户身份是配置（行为即配置，§3.2）

主用户 `person_id` 与 `name` 进 `MemoryConfig`（如 `primaryPersonId` / `primaryPersonName`），缺省给内置默认（如 `person_id='primary'`、`name` 默认值）。`createMemoryStoreFromEnv` 可从环境变量覆盖（与现有 `CHAT_A_MEMORY_*` 一致风格）。杜绝把主用户名硬编码进迁移 SQL。

## Risks / Trade-offs

- **[扁平 recall 把判主语的责任推给上层]** → 缓解：`MemoryRecord.subject` 必带且非空，上层无法忽略；契约测试断言召回结果带正确 subject/personId；canonical §5.4 注入档本就按主语分核心/外围，上层分桶是既定职责。
- **[软关联（无 DB 外键）可能出现悬空 person_id]** → 缓解：P1 只有主用户一行，seed 在 backfill 前；写入默认 personId 取自同一配置；契约测试覆盖"person/shared 记忆 personId 指向已存在主用户、agent 记忆 personId 为空"。
- **[迁移把所有存量记忆一刀切归主用户，可能误并入本应是 agent/shared 的旧记忆]** → 缓解：P1 之前根本没有主语概念，存量记忆事实上全是主用户对话产物，归 person/主用户是语义最保守且无丢失的选择；未来若需重判主语，属离线巩固范畴（§5.8），不在迁移内做。
- **[新增列 + 表增加 schema 复杂度，却 P1 用不满（status/added_by/relationship_state/voiceprint_ref 多为默认/空）]** → 接受:这是 §5.3b 明确要求的"结构先就位免未来重构"，是数据迁移纪律下的有意前置投资；空列不影响延迟。
- **[延迟]** → 纯本地 SQLite，单查询去掉主语过滤、加两列、多一张小表，读写延迟影响可忽略（§3.2 延迟预算），不引入网络/LLM。
