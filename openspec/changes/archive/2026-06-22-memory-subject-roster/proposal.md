## Why

长期陪伴最致命的失败是**自相矛盾**:记不清"这件事是用户说的,还是小雪自己确立过的",或把访客的事安到主用户头上。当前记忆条目**无主语、无人物归属**——既分不清 person/agent/shared,也没有"这是谁"的 `person_id`。canonical §5.3 / §5.3b 要求记忆带 `subject ∈ {person, agent, shared}` 且挂到**人物花名册(people roster)**。

现在虽是单主用户(P1),但 schema 必须**从一开始就支持多主语 + person_id**,否则未来做多人对话(P3)、用户组(P4)时要付出"长期记忆迁移"的高昂代价——而长期记忆/关系数据正是本项目全部价值所在(§3.2 数据迁移纪律)。

## What Changes

- **记忆条目带主语**:`MemoryInput`/`MemoryRecord` 增 `subject ∈ {person, agent, shared}` 字段;写入默认归主用户 `person`,agent 自我事实标 `agent`,共同经历标 `shared`。
- **人物花名册表**:新增 `people(person_id, name, is_primary, status, added_by, relationship_state, voiceprint_ref)`;P1 只 seed **1 个主用户**(`is_primary=1, status=primary`),其余结构就位但不填——为多人/用户组/Agent 自主纳入预留,免未来重构(§5.3b)。
- **记忆挂 person_id**:`person`/`shared` 主语的记忆关联 `person_id`(P1 恒为主用户);`agent` 主语不关联人。
- **跨主语召回**:`recall` 一次返回"关于当前说话人(person)" + "小雪关于自己确立过的(agent)" + "共同经历(shared)",防自相矛盾(§5.3 最后一条)。
- **schema 升版 + 迁移**:沿用 §5.8 / 现有 schema 版本化骨架,迁移脚本把存量记忆默认归为"主用户 / person",**不丢任何旧数据**(§3.2)。

非破坏性:`MemoryStore` 公共方法签名向后兼容(新字段可选、有默认);旧库经迁移自动补主语,不需要消费者改动。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `persistent-memory`: 记忆条目模型增 `subject` + `person_id`;新增 people 花名册(单主用户 seed,结构支持扩展);`recall` 改为跨主语召回;schema 升版并迁移存量数据归属主用户。

## Impact

- **影响 canonical 章节**:§5.3(多主语 + 多人)、§5.3b(人物识别与用户组)、§5.8(写路径)、§3.2(数据迁移纪律)。与权威设计一致,无冲突。
- **代码**:`packages/memory`——`types.ts`(MemoryInput/MemoryRecord/新 Person 类型)、`sqlite-store.ts`(people 表 + 迁移 + 跨主语 recall)、`in-memory-store.ts`(同契约)、`config.ts`(默认主用户 seed 配置)。
- **契约测试**:`MemoryStore` 边界既有契约测试扩展——同一套测试覆盖 InMemory 与 SQLite,验证主语写入/跨主语召回/迁移后存量归属(§3.1)。
- **延迟预算**:纯本地 SQLite 读写,跨主语召回为单查询扩展,不引入网络/LLM,延迟影响可忽略(§3.2)。
- **不涉及**:实时语音管线、向量/语义召回(P2)、说话人声纹识别(P3,本期只建 person_id 结构不做识别)。
