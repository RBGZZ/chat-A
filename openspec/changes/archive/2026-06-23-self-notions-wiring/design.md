## Context

上一批 `self-notions-evolution` 落地了 persona 侧 seam:`SelfNotionsManager({seedNotions,store?,evolver?})`(`current(): SelfNotion[]`、`advance(userText,turn): Promise<void>` opt-in)、`SelfNotionStore`(InMemory + `createKvSelfNotionStore(KvLike)`)、`SelfNotionEvolver` 接缝(无 LLM 实现)。但 `conversation.ts` 仍 `const selfNotions = seed.selfNotions ?? []` 直接喂 `TurnDeps.selfNotions`,`turn-shared.detectStance` 读它。OCEAN 演化已在上批接通(ConversationDeps.oceanEvolver→PersonaEngine),self-notions 是对称的缺口。`memory`(MemoryStore)结构上满足 `KvLike`(getState/setState)。

约束:对外等价(默认不演化)、延迟预算(演化在收尾、首字之后)、接缝边界、优雅降级、复用单一 manager。

## Goals / Non-Goals

**Goals:** 回合用 SelfNotionsManager 源立场(持久化 + opt-in 演化);加 LlmSelfNotionEvolver;cli 开关;默认等价当前。
**Non-Goals:** 新增立场条目;确定性演化器;流式中演化;改 self-notions schema。

## Decisions

### D1:TurnDeps 用 `selfNotionsManager` 取代静态 `selfNotions`

`TurnDeps.selfNotions: readonly SelfNotion[]` → `TurnDeps.selfNotionsManager: SelfNotionsManager`。`turn-shared.detectStance` 改读 `deps.selfNotionsManager.current()`(每轮反映演化)。**单一改点**:两策略都经 turn-shared.detectStance,故只此一处 + TurnDeps 定义变。**备选**:TurnDeps 同时留 selfNotions 静态——会与演化后值不一致,弃。

### D2:演化在 finalizeTurn 推进(收尾,首字之后)

`finalizeTurn` 在 `persona.advance` 之后调 `deps.selfNotionsManager.advance(userText, turn)`(opt-in:无 evolver 则 no-op)。与 persona 情绪推进同位、同为"回合收尾、不挡流式"。需要轮次:`TurnContext` 增 `turn: number`(Conversation 用 #turnSeq 填),finalizeTurn 经 args 拿到。advance 自带容错(失败不抛)。

### D3:store 用 memory 的 KV

Conversation 构造期 `createKvSelfNotionStore(memory)`(memory 即 KvLike),与 PAD/OCEAN 复用同一 SQLite KV 真相源,独立 key(persona 侧已定)。无需新增 ConversationDeps 依赖。测试用 InMemoryMemoryStore(空→seed 种子)。

### D4:LlmSelfNotionEvolver(persona,仿 LlmOceanEvolver)

`evolve(ctx)`:给 LLM 编号的当前立场 position + 用户输入,要它返回"被强化的立场编号 + 小幅增量"的 JSON;`tolerantJsonParse` + 校验(下标合法、delta 数值)→ 映射成 `SelfNotionStrengthDelta[]`(topicKey 取该 notion 的 topicKeyOf);任何失败 → null。增量上限由 manager 的 clampStrengthDelta 兜底(evolver 给小正值即可)。默认关(cli opt-in)。

### D5:ConversationDeps.selfNotionEvolver? + cli 开关

`ConversationDeps` 加可选 `selfNotionEvolver?: SelfNotionEvolver`;Conversation 构造 manager 时条件注入。cli `CHAT_A_SELF_NOTIONS_EVOLVE=llm` → `new LlmSelfNotionEvolver({provider})`;横幅显示。

## Risks / Trade-offs

- **改 TurnDeps 形状**(selfNotions→manager)→ 影响 turn-shared + 两策略只经 detectStance 一处;全量 runtime 回归(对外等价)作安全网,必须仍绿。
- **持久化默认开启**(即便无 evolver,manager 带 store 会 seed/load)→ 默认 current()==种子,行为等价;但若用户改了卡的 selfNotions 而 store 有旧值,manager 用 store 旧值(seed 仅首启)——这是设计的"活在 store"语义,记录在案(与 OCEAN/PAD 同)。
- **演化收尾增 LLM 往返**(启用时)→ 在首字之后、失败降级,不挡流式;默认关。

## Migration Plan

1. persona:`LlmSelfNotionEvolver` + 导出。
2. runtime `conversation.ts`:TurnDeps.selfNotionsManager;构造 manager(store=createKvSelfNotionStore(memory),opt-in evolver);ConversationDeps.selfNotionEvolver?;TurnContext.turn(#turnSeq);strategy.run 传 turn。
3. runtime `turn-shared.ts`:detectStance 读 manager.current();finalizeTurn 调 manager.advance(userText, turn)。
4. 两策略(SingleShot/ToolCalling):run 收尾传 turn 给 finalizeTurn。
5. cli:CHAT_A_SELF_NOTIONS_EVOLVE 开关 + 横幅。
6. 测试:默认等价(无 evolver,current==seed、stance 不变、全量回归绿);注入 spy evolver→advance 被调、立场强度变、跨"重启"(同 store 新 manager)持久;LlmSelfNotionEvolver FakeLlm 往返 + 降级。
7. 回滚:不设 CHAT_A_SELF_NOTIONS_EVOLVE → 等价当前;manager 默认 current==种子。

## Open Questions

- 演化轮次 turn 用 #turnSeq(会话内回合序)即可;跨会话是否累计——本期用会话内序,manager 快照已带 turn,够追溯。
