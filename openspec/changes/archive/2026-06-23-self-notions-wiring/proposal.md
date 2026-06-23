## Why

上一批落地了 self_notions 的持久化 + 强度演化 **seam**(`SelfNotionsManager`/`SelfNotionStore`/`SelfNotionEvolver`),但回合编排层 `Conversation` 仍直接读**静态种子** `seed.selfNotions`,演化 seam 没接进回合,也没有 LLM 演化器实现——所以小雪的立场目前仍不会随相处成长。本切片把它**端到端接通**:回合用 `SelfNotionsManager`(持久化 + opt-in 演化)作为立场来源,补 `LlmSelfNotionEvolver`,cli 加开关。这是上一批我明确标注的"碰焊点、单独成片"的接线。

## What Changes

- **新增 `LlmSelfNotionEvolver`(persona)**:实现 `SelfNotionEvolver`,据本轮对话让 LLM 判定"用户确立/强化了哪几条立场"→ 返回 `SelfNotionStrengthDelta[]`;容错 JSON + 失败/乱码/null 降级(沿用 `LlmOceanEvolver` 范式,默认关)。
- **Conversation 用 `SelfNotionsManager` 源立场**:构造期建 manager(`seedNotions=seed.selfNotions`,`store=createKvSelfNotionStore(memory)` 持久化,`evolver=deps.selfNotionEvolver` opt-in);`TurnDeps` 用 manager 取代静态 `selfNotions`;分歧检测每轮读 `manager.current()`(反映演化);回合收尾(finalizeTurn)调 `manager.advance(userText, turn)` 推进演化。
- **`ConversationDeps` 增 `selfNotionEvolver?`**(opt-in);`TurnContext` 增 `turn: number`(供 manager.advance 的演化轮次)。
- **cli 接通**:`CHAT_A_SELF_NOTIONS_EVOLVE=llm` 启用 `LlmSelfNotionEvolver`(默认关);横幅显示。

Non-goals:不新增立场条目(只演化已有立场强度);确定性默认演化器(语义判定需 LLM);self_notions 之外的演化(OCEAN 演化已在上批接通)。

## Capabilities

### Modified Capabilities
- `stance-disagreement`: 立场来源从静态种子升级为**持久化 + opt-in 演化的 `SelfNotionsManager`**——回合每轮读演化后立场、收尾推进演化;新增 `LlmSelfNotionEvolver` 与 `selfNotionEvolver` 注入入口。默认(不注入 evolver)行为等价当前(立场恒定)。

## Impact

- **延迟预算(§3.2)**:默认(无 evolver)= manager.advance no-op,`current()` 即种子,**回合内零额外开销**;启用 LLM 演化器时,演化在**回合收尾**(首字之后)异步进行,失败降级,不挡流式。
- 代码:`@chat-a/persona` 加 `LlmSelfNotionEvolver` + 导出;`@chat-a/runtime` `conversation.ts`(TurnDeps:selfNotions→selfNotionsManager;ConversationDeps.selfNotionEvolver?;TurnContext.turn)+ `turn-shared.ts`(detectStance 读 manager.current()、finalizeTurn 调 manager.advance);`@chat-a/client` cli 开关 + 横幅。
- 持久化:复用 memory 的 KV(createKvSelfNotionStore(memory)),独立 key,不动 schema;默认行为等价当前。
- 兼容:`SelfNotionsManager` 默认(有 store 无 evolver)current()==种子 → stance 命中与现有一致;全量回归(SingleShot/ToolCalling 对外等价)须仍绿。
