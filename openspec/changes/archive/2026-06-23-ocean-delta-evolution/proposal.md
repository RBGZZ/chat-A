## Why

小雪的人格(OCEAN)目前是**种子固定**的:`engine.ts` 的 `advance()` 每回合只做即时 OCC→PAD 弹簧步进(心情会变),但 **OCEAN 五维永不变**——相处再久,性格也不会被这段关系"磨"出半点变化。这违背北极星"长期伴侣 not 助手":真正的伴侣会随相处**缓慢演化**(canonical §6.1 "delta 演化":即时 OCC→PAD + 每 20 轮二级 OCEAN 信号分析 + 版本快照 history)。

即时情绪(PAD)是**快变量**,二级 OCEAN delta 是**慢变量**——本次补上后者:每 N 轮据近段对话给 OCEAN 五维一个极小的微调(单次上限 ±0.01),并把每次演化存成可回溯/可回滚的版本快照。

## What Changes

- **二级 OCEAN delta 演化(慢变量)**:`advance()` 内部按轮次节拍(默认每 20 轮,外置可配)触发一次二级信号分析——据近段对话给 OCEAN 五维产出微调 delta,**单次每维 delta 钳制 ±0.01**,写回 OCEAN(再钳到 OCEAN 合法区间 [0,1])。
- **可注入 LLM 信号分析器(opt-in)**:沿用 `llm-appraiser.ts` 的 `complete + tolerantJsonParse + 失败降级` 范式,新增 `OceanEvolver` 接缝 + `LlmOceanEvolver` 实现。**默认关**(不注入则不演化,OCEAN 恒定);无 LLM/解析失败/无有效维度 → 跳过本次演化,人格不变,回合不受影响。
- **版本快照 history(数据迁移纪律)**:每次实际演化把一条 `OceanDeltaSnapshot`(旧 OCEAN → 新 OCEAN + delta + 触发轮次 + 时间戳)追加进持久化 history,可回溯/可回滚。
- **持久化做向后兼容的加法**:`PersonaSnapshot` 新增**可选** `history` 字段;旧快照(无 history)正常读回(视为空 history),不丢人格状态。
- **触发节拍配置外置**:演化周期 N 与 delta 上限进 `PersonaConfig`(行为即配置,无 magic number)。

## Capabilities

### Modified Capabilities
- `persona-emotion`: 在既有数值人格/情感内核之上,新增"二级 OCEAN delta 演化 + 版本快照 history"(慢变量演化层),并扩展持久化快照为向后兼容的带 history 形态。

## Impact

- **canonical 章节/接缝**:§6.1(delta 演化:每 20 轮二级 OCEAN 信号分析、delta 上限 ±0.01、版本快照 history)、§3.1(新增 `OceanEvolver` 接缝,与 `Appraiser` 同构)、§3.2(确定性钳制/节拍/快照写 golden;LLM 走 record-replay + 失败降级;迁移纪律:schema 加法 + 人格状态绝不丢)。
- **代码(仅 `packages/persona/**`)**:新增 `ocean-evolution.ts`(`OceanEvolver` 接缝 + delta 钳制 + 快照构造,确定性纯函数)、`llm-ocean-evolver.ts`(LLM 实现,降级)。`types.ts` 加 `OceanDelta`/`OceanDeltaSnapshot`/`OceanEvolver`,`PersonaSnapshot` 加可选 `history`,`PersonaConfig` 加 `evolutionEveryTurns`/`maxOceanDeltaPerStep`。`engine.ts` 的 `advance()` 内部按节拍触发演化(**不改调用方** runtime/conversation.ts)。`store.ts` 的快照校验放宽以接受可选 history。`defaults.ts` 加默认配置值。
- **不改**:runtime、cognition、memory、providers、protocol、observability、client、persona.example.yaml。持久化复用现有 `PersonaStore`(KvLike)接缝。
- **延迟预算(§3.2)**:演化为**每 N 轮一次**的回合后异步动作,不进语音热路径;LLM 版默认关,启用时也只在 N 的倍数轮发起一次额外 complete,失败即跳过,不阻塞回合。

## Non-goals

- 离线双 Pass 调和(update/delete 记忆,§5.8)——不在本切片。
- OCEAN 演化的 UI / 回滚操作入口——本切片只保证 history 可回溯/数据具备回滚条件,不做交互。
- 调整即时 PAD 弹簧/冷启动等既有内核行为(只加慢变量层,不动快变量)。
- 改 `advance()` 的调用点或 runtime 接线(演化在 engine 内部触发)。
