# 设计:二级 OCEAN delta 演化 + 版本快照

## 背景与定位

人格内核有两个时间尺度的变量(§6.1):
- **快变量 PAD**:每回合即时 OCC→PAD 弹簧步进(已落地,`stepPad`)。心情秒级起伏。
- **慢变量 OCEAN**:相处日久才被"磨"出微变。本切片补上。

二者解耦:PAD 步进不变;OCEAN 演化是叠加在其上的、稀疏触发(每 N 轮)的极小调整。OCEAN 变化后,下一轮 `oceanToPadBaseline` 自然产出略微不同的基线 → PAD 长期重心随之缓慢漂移,无需额外接线。

## 关键决策

### 1. 接缝:`OceanEvolver`(与 `Appraiser` 同构)
新增接缝,异步以容纳 LLM:
```ts
interface OceanEvolveContext {
  readonly recentUserTexts: readonly string[]; // 近段对话(本周期累积的用户输入)
  readonly ocean: Ocean;                        // 当前 OCEAN
  readonly turn: number;                         // 触发轮次
}
interface OceanEvolver {
  evolve(ctx: OceanEvolveContext): Promise<OceanDelta | null>; // null = 本次不演化
}
```
- **默认不注入** = 不演化(OCEAN 恒定)。沿用"默认确定性/LLM opt-in/失败降级"范式:与 appraiser 不同的是,这里**没有确定性默认实现**(确定性地猜性格漂移没有意义且危险),所以默认行为就是"关"。`engine` 只在显式注入 `oceanEvolver` 时才在节拍轮触发。

### 2. delta 钳制(确定性纯函数,golden)
`clampOceanDelta(raw, max)`:把任意来源的 delta 每维钳到 `[-max, +max]`(默认 max=0.01);非有限值视作 0。`applyOceanDelta(ocean, delta)`:逐维相加后用 `clamp01` 钳回 [0,1]。两者纯函数、可写 golden。**单次 delta 上限 ±0.01** 是硬约束,即使 LLM 返回 ±1 也被钳到 ±0.01。

### 3. 触发节拍(确定性,golden)
`shouldEvolve(turn, everyTurns)` = `turn > 0 && turn % everyTurns === 0`。在 `advance()` 里 PAD 步进、turn 自增之后判定;命中且注入了 evolver 才发起。`everyTurns` 默认 20,进 `PersonaConfig`。

### 4. 版本快照 history(数据迁移纪律)
```ts
interface OceanDeltaSnapshot {
  readonly turn: number;
  readonly at: string;        // ISO 时间戳(可回溯)
  readonly before: Ocean;     // 旧 OCEAN(可回滚到此)
  readonly after: Ocean;      // 新 OCEAN
  readonly delta: OceanDelta; // 实际应用的(已钳制)delta
}
```
每次**实际发生**演化(delta 非全零/非 null)才追加一条。`PersonaSnapshot.history?: readonly OceanDeltaSnapshot[]`——**可选字段**(exactOptionalPropertyTypes:条件展开,不写 `history: undefined`)。

**向后兼容**:旧快照无 history → 读回时缺字段 → engine 视作空数组。`store.ts` 的 `isValidSnapshot` 放宽:`history` 缺失合法;存在则须为数组(逐条不深校,损坏单条不致整快照作废——但若整个 history 非数组则丢弃 history 字段而非丢整快照,保人格状态)。决策:**人格状态(ocean/pad/turn)绝不因 history 损坏而丢**。

### 5. LLM 实现 `LlmOceanEvolver`(record-replay + 降级)
照 `llm-appraiser.ts`:`provider.complete` 要 JSON(五维 delta)→ `tolerantJsonParse` → 校验/钳制。任何失败(异常/乱码/无有效维度)→ 返回 `null`(= 本次不演化),engine 跳过,OCEAN 不变,回合不受影响。`onError` 回调供 trace。

### 6. engine 接线(不改调用方)
`advance()` 内部,PAD 步进 + 持久化之前,累积 `recentUserTexts`(进程内 ring,上限本周期);turn 命中节拍且有 evolver 时:`await evolver.evolve(...)` → 钳制 → 应用 → 构造快照追加 history → 一并写入 `PersonaSnapshot`。失败/null 跳过。`recentUserTexts` 触发后清空。**advance 签名不变**,runtime 调用点零改动。

## 取舍

- 不做确定性 OCEAN 演化默认实现:性格漂移需语义理解,确定性词典猜不可信;默认关比默认乱演化安全。
- recentUserTexts 仅进程内累积(不持久化):跨重启丢失近段窗口可接受(下个周期重新累积);避免改 PersonaSnapshot 持久化更多易变数据。
- history 不设上限裁剪(本切片):演化稀疏(每 20 轮一条),增长极慢;裁剪策略留后续。
