# 设计:self_notions 持久化 + 保守强度演化

## 背景与定位

`self_notions`(§7#3)是小雪"会反对"的依据。它当前停在**只读静态种子**阶段,而隔壁 OCEAN(§6.1)早已是"种子 seed → 活在 store → delta 演化 + 版本快照"。本切片把 `self_notions` 抬到同一范式,且严守一条铁律:**默认行为严格等价当前**(只读种子、不演化)——所有新能力都是 opt-in 的加法,现有 stance/persona 测试必须原样通过。

类比 OCEAN 的两尺度变量:
- 立场的**存在与文本**是种子给的静态骨架(不变)。
- 立场的**强度**是慢变量:某立场被一次次确立/强化,`strength` 极缓慢上升,`stance` 据此调制"是否/多强地表达"。

## 关键决策

### 1. `SelfNotion` 加可选强度(纯加法,向后兼容)
```ts
interface SelfNotion {
  readonly topic: readonly string[];
  readonly position: string;
  readonly strength?: number;     // 立场强度 [0,1];缺省 = 未标注,按种子基线处理
  readonly affirmCount?: number;  // 被确立/强化的次数;缺省 = 0
}
```
- 旧种子(4 条,无 strength)与旧持久化照常工作:读到缺省 → 视作基线强度 `SELF_NOTION_BASE_STRENGTH`(外置,默认中性),不改变现有 stance 命中行为。
- exactOptionalPropertyTypes:构造时**条件展开**,绝不写 `strength: undefined`。

### 2. 持久化:`SelfNotionStore`(复用 `KvLike`,独立 key)
不碰 `persona:snapshot`(OCEAN/PAD),新开 KV key `persona:self_notions`,结构带 **schema 版本**:
```ts
interface SelfNotionsState {
  readonly version: number;                       // schema 版本(当前 1)
  readonly notions: readonly SelfNotion[];        // 演化后的立场(含强度)
  readonly history?: readonly SelfNotionSnapshot[]; // 强度演化版本快照(可选)
}
```
- `SelfNotionStore.load()`:无 key → `null`(交编排层用种子 seed);有 key → 解析 + 校验 + 迁移。解析失败/形状非法 → `null`(回落种子,优雅降级)。
- `SelfNotionStore.save(state)`:JSON 序列化写 key。
- 基于 `KvLike`(结构类型),runtime 可注入同一 store,persona 不依赖 memory 包(与 `createKvPersonaStore` 同构)。

### 3. seed 化与回落(首启用种子,之后活在 store)
`SelfNotionsManager`(薄编排,纯进程内):
- 构造接收 `seedNotions`(来自 PersonaSeed)+ 可选 `store` + 可选 `evolver`。
- 初始化:`store.load()` 有 → 用之;无 → 用 `seedNotions` 包成 v1 state 并(若有 store)**seed 落库一次**。store 缺省/损坏 → 始终能回落 `seedNotions`(绝不空手)。
- `current()`:返回当前(可能已演化的)`readonly SelfNotion[]`,直接喂给 stance 检测。
- **默认无 store 无 evolver**:`current()` 恒等于 `seedNotions` —— 等价当前只读种子。

### 4. 保守强度演化(确定性纯函数 + opt-in 接缝)
```ts
interface SelfNotionStrengthDelta { readonly topicKey: string; readonly delta: number; }
interface SelfNotionEvolveContext {
  readonly userText: string;
  readonly notions: readonly SelfNotion[];
  readonly turn: number;
}
interface SelfNotionEvolver {
  // 返回本轮要强化哪些立场(按 topicKey 定位)+ 强度增量;null/空 = 不演化
  evolve(ctx: SelfNotionEvolveContext): Promise<readonly SelfNotionStrengthDelta[] | null>;
}
```
- **默认不注入 = 不演化**(沿用 appraiser/oceanEvolver 范式;无确定性默认演化器——确定性猜"立场被确立"不可信)。
- 纯函数三件套(golden):
  - `clampStrengthDelta(raw, max)`:把单次 delta 钳到 `[0, +max]`(只增不减,保守;非有限→0)。单次上限 `maxStrengthDeltaPerStep`(外置,默认很小)。
  - `applyStrengthDelta(notion, delta)`:`strength = clamp01((notion.strength ?? base) + delta)`,`affirmCount = (notion.affirmCount ?? 0) + 1`。
  - `buildSelfNotionSnapshot(before, after, delta, turn, at)`:版本快照(可回溯/回滚)。
- `SelfNotionsManager.advance(userText, turn)`(opt-in):若注入 evolver → `evolve` → 对每个 delta 定位立场 → 钳制(全零跳过)→ 应用 → 追加 history → `save`。失败/null/全零 → 跳过、不写、立场不变、绝不抛(§3.2)。未注入 evolver → no-op。

### 5. 版本快照 history(数据迁移纪律)
```ts
interface SelfNotionSnapshot {
  readonly turn: number;
  readonly at: string;          // ISO 时间戳
  readonly topicKey: string;    // 哪条立场(topic 首关键词为键)
  readonly before: number;      // 旧 strength(回滚目标)
  readonly after: number;       // 新 strength
  readonly delta: number;       // 实际应用(已钳制)的增量
}
```
每次**实际发生**强化才追加一条。`history` 可选;旧 state 无 → 视作空。

### 6. schema 迁移(立场状态绝不丢)
`migrateSelfNotionsState(parsed)`:
- 无 `version`/version<1 的旧形态 → 当作 v0:若是合法 `SelfNotion[]` 数组(或带 notions 的对象)→ 升到 v1,补 version,逐条补 strength/affirmCount 缺省(**不丢 topic/position**)。
- `notions` 非数组/损坏 → 返回 `null`(回落种子比带病续接安全)。
- `history` 非数组 → 丢弃 history 字段而非丢整 state(与 OCEAN store 同纪律:立场条目绝不因 history 损坏而丢)。

### 7. stance 读演化后立场(默认不变)
`DefaultStanceDetector` 已据 `ctx.selfNotions` 命中。强度调制做成**可选、保守**:
- 新增可选构造项 `strengthFloor`(外置默认):命中后,若某立场 `strength`(缺省按基线视作"足够")**低于** `strengthFloor` 且 assertiveness 也不高,则该立场更易被压制(更趋沉默)。
- **关键**:缺省强度(旧种子无 strength)按"基线足够"处理 → **命中行为与当前完全一致**;只有显式标了**低**强度的立场才会被额外压制。这样既让"强度可影响表达",又不破现有测试。

## 取舍

- **强度只增不减(本切片)**:保守强化好实现、好测、不会误删立场;衰减/遗忘是更危险的演化,留后续。
- **独立 KV key**:与 OCEAN 快照解耦,各自迁移、爆炸半径小;不污染 `persona:snapshot`。
- **不接 runtime**:严格只动 persona 包;runtime 仍读 `seed.selfNotions`(默认等价)。接入演化后立场到 conversation.ts 留后续切片(接缝已就绪)。
- **history 不裁剪**:演化稀疏(仅"确立"时),增长慢;裁剪留后续。
- **无确定性默认演化器**:与 OCEAN 一致——默认关比默认乱演化安全。
