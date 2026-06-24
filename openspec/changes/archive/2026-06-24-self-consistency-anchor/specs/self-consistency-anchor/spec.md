## ADDED Requirements

### Requirement: SelfConsistencyGuard 自我一致性检测接缝

系统 SHALL 提供 `SelfConsistencyGuard` 接缝:据本轮回复(候选/已生成文本)与**注入的核心自我记忆**(subject=agent 的 core_belief/self_notion/self_lore,由回合编排层用既有 recall 召回后以最小结构 `SelfMemoryRef` 传入)判定回复是否与**确立过的核心自我矛盾**(漂移)。接缝 `check(ctx)` SHALL 异步(以容纳 LLM 实现;确定性实现返回已决议 Promise),产出 `AnchorResult { drift, reason?, anchorText? }`。persona MUST NOT 依赖 memory 包内部或 embedder(接缝边界 §3.1;语义召回在 persona 之外完成,Guard 只消费召回结果)。

#### Scenario: 召回核心自我记忆后判定

- **WHEN** 编排层在回复生成后调用 `check({ reply, selfMemories, agentName })`
- **THEN** Guard 返回 `AnchorResult`,`drift` 表示回复是否与确立过的核心自我矛盾,矛盾时 `anchorText` 指向命中的核心锚点

#### Scenario: 无核心自我记忆时不锚定

- **WHEN** `selfMemories` 为空且无 `agentName`
- **THEN** Guard 返回 `{ drift: false }`(无可锚定的核心自我,降级为不锚定,不抛错)

### Requirement: 确定性 Guard 保守判定且放宽阈值

系统 SHALL 提供**确定性默认实现** `DefaultSelfConsistencyGuard`,只对**核心锚点**(`agentName` + `selfMemories` 中标注 `core` 的条目;strictness 默认 `core-only`)做**显式否定线索**命中——回复中出现外置否定线索词(`NEGATION_CUES`)且邻近某核心锚点关键词时,记为漂移。确定性实现 MUST NOT 臆测语义层面的同异(语义级矛盾判定交由 opt-in LLM 实现)。确定性实现 MUST 对一切不命中"核心锚点否定模式"的输入返回 `{ drift: false }`——**观点变化、表达不同意、产生新喜好/兴趣、情绪措辞波动 MUST NOT 被判为漂移**(放宽阈值,§6.1:别把"我不同意"当漂移拉回)。否定线索词表与锚点关键词最小长度 MUST 外置可配(行为即配置,无 magic number)。

#### Scenario: 否定核心设定 → 判漂移

- **WHEN** 回复显式否定核心锚点(如核心记忆「我叫小雪」而回复出现"我不叫小雪")
- **THEN** Guard 返回 `drift: true` 且 `anchorText` 指向被否定的核心锚点

#### Scenario: 表达不同意 → 不判漂移

- **WHEN** 回复表达"我不同意你的看法"或对用户观点的异议(未否定任何核心自我设定)
- **THEN** Guard 返回 `drift: false`(异议是"有自我"的体现,不是漂移)

#### Scenario: 改主意 / 新喜好 → 不判漂移

- **WHEN** 回复体现观点改变或新产生的喜好/兴趣(如"我最近反而开始喜欢X了"),且未否定核心设定
- **THEN** Guard 返回 `drift: false`(有个性的偏离,放宽阈值允许)

#### Scenario: 无否定线索 → 不判漂移

- **WHEN** 回复未出现任何否定线索词,或否定线索未邻接核心锚点
- **THEN** Guard 返回 `drift: false`

### Requirement: LLM Guard 可选且失败降级为不锚定

系统 SHALL 允许注入 **LLM 实现** `LlmSelfConsistencyGuard`(opt-in,默认关),据回复 + 核心自我记忆走 **schema 约束**输出 `{"drift": boolean, "reason": string}`。其 prompt MUST 显式放宽阈值:只有否定核心设定(名字/根本信念/根本人设)才算 drift,观点改变/不同意/新喜好/情绪波动不算。LLM 调用任何失败(异常/乱码/字段缺失/越界)时 MUST 降级为 `{ drift: false }`(不锚定),绝不抛出中断回合(§3.2);失败 MAY 经 `onError` 上报。

#### Scenario: LLM 判定否定核心设定为漂移

- **WHEN** 注入 LLM Guard 且其返回 `{"drift": true, "reason": "..."}`
- **THEN** Guard 产出 `drift: true` 并携带理由

#### Scenario: LLM 调用失败降级

- **WHEN** 注入 LLM Guard 且其调用抛错或返回非法 JSON
- **THEN** Guard 返回 `{ drift: false }`(不锚定),回合继续,不抛出中断

### Requirement: 漂移时温和重锚

系统 SHALL 提供 `ReAnchorContributor`,注册到 §5.4 PromptAssembler 的高优先级"重锚"槽(`PROMPT_PRIORITY.reAnchor`,位于 dissent 之后)。当且仅当本轮 `ctx.anchor.drift === true` 时,contributor SHALL 注入一段温和重锚 steer:提示以确立过的自我为准、自然地把核心设定说回正,同时**明确保留个性偏离**(允许不同观点/改主意/新喜好,不必收回)。无 `anchor` 或 `drift === false` 时 contributor MUST 返回 `null`(默认路径零注入)。contributor MUST 同步、无 I/O(承接缝契约)。重锚是**注入下轮 steer**,本期 MUST NOT 改写或截断已生成回复。

#### Scenario: 漂移时注入重锚 steer

- **WHEN** `ctx.anchor = { drift: true, anchorText: "我叫小雪" }`
- **THEN** ReAnchorContributor 产出含"以确立过的自我为准 / 保留个性偏离"语义的高优先级片段(priority = reAnchor)

#### Scenario: 未漂移不注入

- **WHEN** `ctx.anchor` 缺省或 `drift === false`
- **THEN** ReAnchorContributor 返回 `null`,不产出任何重锚段

### Requirement: 自我一致性锚定缺省安全且可配

自我一致性锚定 SHALL 由 `SelfConsistencyConfig { enabled, strictness }` 门控,`enabled` 缺省 **false**、`strictness` 缺省 `core-only`。当 `enabled === false` 时 Guard MUST 等价不锚定(对任何输入返回 `{ drift: false }`),使既有回合行为字面不变(缺省安全)。`strictness` SHALL 控制锚点范围(`core-only`=仅 name + 核心档记忆;`all-self`=放宽到全部注入的自我记忆)。所有阈值/词表/严格度 MUST 外置可配(行为即配置,§3.2)。

#### Scenario: 默认关时行为不变

- **WHEN** 未启用自我一致性锚定(`enabled` 缺省 false)
- **THEN** Guard 不判任何漂移、不注入重锚,回合行为与未引入本能力时字面一致

### Requirement: 锚定判定可追溯

`SelfConsistencyGuard` SHALL 暴露可选 `onDecision` sink:每次判定后回调一次,携带 `{ drift, reason?, anchorText?, mode }`(mode ∈ default|llm),供编排层落 SQLite 决策 trace(§8.1)。persona 侧 MUST 仅留 sink 接缝、不依赖 observability 包;未注入 sink 时不记、不影响判定。

#### Scenario: 注入 sink 时记录判定

- **WHEN** 注入了 `onDecision` 且 Guard 完成一次判定
- **THEN** sink 被调用一次,携带本次判定的 drift/理由/命中锚点/模式
