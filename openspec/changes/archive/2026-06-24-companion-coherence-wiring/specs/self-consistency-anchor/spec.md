## ADDED Requirements

### Requirement: 自我一致性 Guard 接进回合流程

系统 SHALL 在回合编排层(runtime)把 `SelfConsistencyGuard` 接进回合流程:当注入了 Guard 时,回合体 SHALL 在**回复生成之后**(首字之后,不阻塞流式)调用 `guard.check({ reply, selfMemories, agentName })`,其中 `selfMemories` 由编排层从既有 `memory` 召回结果中筛 `subject==='agent'` 的核心自我记忆映射为 `SelfMemoryRef[]`(persona MUST NOT 依赖 memory 包,接缝边界 §3.1),`agentName` 取自人格种子。`ReAnchorContributor` SHALL 在 `Conversation` 构造期注册进 `PromptAssembler`。Guard 判定 `drift === true` 时,编排层 SHALL 把对应 `AnchorInput { drift:true, anchorText? }` 透传到**下一轮**的 `PromptContext.anchor`(由 `ReAnchorContributor` 注入温和重锚),用过即清(重锚不粘连多轮)。Guard 调用任何失败 SHALL 降级为不锚定、回合继续,绝不抛出中断(§3.2)。本期 MUST NOT 改写或截断已生成回复。

#### Scenario: 注入 Guard 且判漂移 → 下轮重锚

- **WHEN** 注入了 Guard,某回合回复生成后 `guard.check` 返回 `{ drift: true, anchorText }`
- **THEN** 下一轮 `PromptContext.anchor.drift === true` 且 `anchorText` 透传,`ReAnchorContributor` 注入温和重锚 steer

#### Scenario: 注入 Guard 但不漂移 → 下轮不填 anchor

- **WHEN** 注入了 Guard 且 `guard.check` 返回 `{ drift: false }`
- **THEN** 下一轮 `PromptContext.anchor` 不被填充(缺省/drift=false),`ReAnchorContributor` 返回 `null`,无重锚段

#### Scenario: Guard 失败降级不崩

- **WHEN** 注入了 Guard 且其 `check` 抛错或召回为空
- **THEN** 本轮不锚定、不影响回复落库与回合收尾,回合继续(§3.2),不抛出中断

### Requirement: 自我一致性 Guard 由 cli 按开关装配且缺省关回归绿

cli SHALL 由环境开关 `CHAT_A_SELF_CONSISTENCY=off|on|llm`(缺省 `off`)装配并注入 Guard:`on` 创建启用态确定性 `DefaultSelfConsistencyGuard`(`config.enabled=true`),`llm` 创建启用态 `LlmSelfConsistencyGuard`(注入 `provider`),`off`/缺省/其它**不创建、不注入**。装配的 Guard SHALL 把 `onDecision` 适配进既有决策 trace sink(有 sink 才记,§8.1)。当缺省 `off` 时,`Conversation` MUST NOT 调用任何 Guard、MUST NOT 为锚定额外召回,`PromptContext.anchor` 恒空、`ReAnchorContributor` 恒返回 `null`,**回合行为与未引入本接线时字面一致**(缺省安全)。开关取值/严格度阈值 MUST 外置可配(行为即配置,§3.2)。

#### Scenario: 缺省 off 时行为不变

- **WHEN** 未设置 `CHAT_A_SELF_CONSISTENCY`(缺省 off)
- **THEN** cli 不创建 Guard,回合不调用 Guard、不注入重锚,行为与未引入本接线时逐字一致(既有测试全绿)

#### Scenario: on → 注入启用态确定性 Guard

- **WHEN** `CHAT_A_SELF_CONSISTENCY=on`
- **THEN** cli 注入 `config.enabled=true` 的 `DefaultSelfConsistencyGuard`,回合在回复后调用其判定

#### Scenario: llm → 注入启用态 LLM Guard

- **WHEN** `CHAT_A_SELF_CONSISTENCY=llm`
- **THEN** cli 注入启用态 `LlmSelfConsistencyGuard`(带 provider),失败时降级为不锚定(§3.2)
