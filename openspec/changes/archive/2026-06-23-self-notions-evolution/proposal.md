## Why

小雪的"自我观点"(`self_notions`,§7#3 反对依据)目前是**只读静态种子**:`XIAOXUE_SEED.selfNotions` 写死 4 条,`DefaultStanceDetector` 据之命中产异议。这有两个缺口:

1. **不可持久化、不可演化**:无论相处多久、某个立场被反复确立强化多少次,她的观点强度始终如一——种子是死的。这违背北极星"长期伴侣 not 助手":真正的伴侣,某些看法会因一次次交锋而**更坚定**。
2. **与已落地的人格演化层不一致**:OCEAN(§6.1)已经"种子 seed → 活在 store → 每 N 轮 delta 演化 + 版本快照";`self_notions` 还停在只读阶段。

本切片把 `self_notions` 抬到与 OCEAN 同一范式:**首启用种子 seed,之后活在 store(KV,带 schema 版本 + 迁移,向后兼容,缺省回落种子)**;并加一条**保守的强度演化路径**——确立/强化某立场时给它一个极小的强度增量(单次有上限、版本快照可回溯),stance 检测读"演化后的"立场。**默认行为严格等价当前**(只读种子、不演化),不破现有 stance 测试。

## What Changes

- **`self_notions` 从只读种子 → 可持久化 + 可演化**:新增 `SelfNotionStore`(复用现有 `PersonaStore`/`KvLike` 接缝,独立 KV key)。首启用种子 seed 一份带 schema 版本的快照;之后读写都走 store;store 缺省/损坏 → 回落种子(优雅降级,§3.2)。
- **`SelfNotion` 加可选强度字段(纯加法)**:新增可选 `strength`(立场强度 [0,1])与 `affirmCount`(确立计数)。旧种子/旧快照无此字段照常工作(缺省视作种子强度基线)。
- **保守强度演化(opt-in)**:新增 `SelfNotionEvolver` 接缝(沿用 `appraiser`/`oceanEvolver` 的 opt-in 范式)。某条立场在对话中被**确立/强化**时,给其 `strength` 一个**单次上限钳制**的正向 delta(默认 ±上限很小),`affirmCount`+1,并追加一条**版本快照**(可回溯/可回滚,承 §6.1 演化纪律)。**默认不注入 = 不演化 = 等价当前只读种子**;失败降级、绝不打断回合。
- **stance 读"演化后的"立场**:`DefaultStanceDetector` 可接收"已解析的强度",强度可影响**是否/多强地**表达(低强度立场在低 assertiveness 下更易沉默);默认无强度时行为与当前完全一致。
- **schema 版本 + 迁移(数据迁移纪律)**:持久化结构带 `version` 字段 + 迁移函数;旧无版本/旧字段缺失 → 迁移补默认,**立场状态绝不因迁移丢失**。

## Capabilities

### Modified Capabilities
- `stance-disagreement`: 在既有 `self_notions` + `StanceDetector` 之上,新增"`self_notions` 可持久化 + 保守强度演化 + 版本快照 + schema 迁移";stance 检测可读演化后的立场强度;默认行为等价当前(只读种子、不演化)。

## Impact

- **canonical 章节/接缝**:§7#3(会反对/self_notions)、§6.1(演化纪律:单次 delta 上限 + 版本快照 history)、§3.1(新增 `SelfNotionStore` / `SelfNotionEvolver` 接缝,与 `PersonaStore`/`OceanEvolver` 同构)、§3.2(确定性钳制/迁移写 golden;演化失败降级;迁移纪律:schema 带版本、立场状态绝不丢)。
- **代码(仅 `packages/persona/**`)**:新增 `self-notions.ts`(强度钳制/演化/迁移纯函数 + `SelfNotionStore` + `SelfNotionsManager`)。`types.ts` 给 `SelfNotion` 加可选 `strength`/`affirmCount`,新增 `SelfNotionSnapshot`/`SelfNotionStrengthDelta`/`SelfNotionEvolver`/`SelfNotionStore` 等类型。`stance.ts` 的 `DefaultStanceDetector` 读可选强度(默认不变)。`index.ts` 导出新模块。`defaults.ts` 补强度演化默认配置。
- **不改**:runtime(尤其 conversation.ts)、cli、cognition、memory、providers、protocol、observability、client。持久化复用现有 `PersonaStore`(KvLike)接缝;新结构在 persona 内部完成,独立 KV key,不碰 `persona:snapshot`。
- **延迟预算(§3.2)**:强度演化为回合内**条件触发**的极轻量纯计算(无 I/O),仅在显式注入 evolver 且其判定"确立"时发生;默认关。不进语音热路径关键计算。

## Non-goals

- LLM 驱动的"立场确立"语义判定实现——本切片只立 `SelfNotionEvolver` 接缝 + 确定性触发器示例;LLM 实现留后续(范式已备)。
- 立场的**衰减/遗忘**(强度只增不减)——本切片只做保守的"强化",衰减留后续。
- `self_notions` 的新增/删除演化(运行中长出新观点)——本切片只演化**已有**立场的强度,不增删条目。
- 改 runtime/conversation.ts 接线或 stance 调用点(持久化/演化都在 persona 内部,经现有接缝);runtime 接入留后续切片。
- 立场演化的 UI / 回滚操作入口——只保证 history 可回溯/具备回滚条件,不做交互。
