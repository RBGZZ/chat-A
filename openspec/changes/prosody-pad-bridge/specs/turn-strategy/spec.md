## MODIFIED Requirements

### Requirement: TurnContext 由外壳填充回合上下文

`TurnContext` SHALL 由 `Conversation` 外壳在每回合开始时填充,携带回合执行所需上下文:用户输入 `userText`、token 回调 `onToken`、`turnId`、`correlationId`、外壳已开启的 `turnSpan`、回合起始时间 `turnStartMs`,以及一个只读依赖句柄 `deps`。`TurnContext` MAY 携带可选 `signal?: AbortSignal`(承现有协作取消)。`TurnContext` MAY 携带可选 `prosodyEmotion?: SttEmotionLike`——由外壳从 `send` 的第四形参透传,供策略经 `finalizeTurn` 转交 `persona.advance` 作为语音情绪拉力来源(§7#5);缺省时该字段为 `undefined`,回合的情绪推进与现状逐字一致。策略 MUST 仅消费 `TurnContext` 中字段执行回合,MUST NOT 反向依赖 `Conversation` 实例内部(承 §3.1 接缝边界)。

#### Scenario: 外壳经 ctx.prosodyEmotion 透传语音情绪

- **WHEN** 调用方以 `send(userText, onToken, signal?, prosodyEmotion)` 传入 prosody 情绪
- **THEN** 外壳把该 `prosodyEmotion` 填入 `TurnContext.prosodyEmotion`,策略可经 `ctx.prosodyEmotion` 取得同一值;不传时 `ctx.prosodyEmotion` 为 `undefined`

### Requirement: 回合收尾在两策略间零漂移并可携带 prosody 情绪

`SingleShotStrategy` 与 `ToolCallingStrategy` MUST 共用 `turn-shared` 的 `finalizeTurn` 完成回合收尾(落历史、情绪推进、写记忆、决策 trace),使工具回合与单趟回合的记忆/人格/trace 逐字零漂移。`finalizeTurn` 的 args MAY 携带可选 `prosodyEmotion?: SttEmotionLike`;提供时 `finalizeTurn` MUST 调 `deps.persona.advance(userText, { prosodyEmotion })`(仅在提供时带 opts),否则调 `deps.persona.advance(userText)`(与现状逐字一致)。两个策略 MUST 把各自 `ctx.prosodyEmotion`(若有)经 `finalizeTurn` args 透传,确保 STT 路语音情绪在两种回合范式下都能影响心情。当 `prosodyEmotion` 缺省时,情绪推进调用形状与行为 MUST 与现状等价。`finalizeTurn` 写决策 trace 时 MAY 在提供 `prosodyEmotion` 时附带其 `label`(纯加法,经既有 traceSink 接缝)。

#### Scenario: SingleShot 透传 prosodyEmotion 到 advance

- **WHEN** 以带 `prosodyEmotion` 的 `TurnContext` 跑 `SingleShotStrategy`
- **THEN** `finalizeTurn` 以 `persona.advance(userText, { prosodyEmotion })` 推进情绪;不带时以 `persona.advance(userText)` 推进,与现状一致

#### Scenario: ToolCalling 与 SingleShot 同源透传

- **WHEN** 以带同一 `prosodyEmotion` 的 `TurnContext` 分别跑两策略
- **THEN** 两者都经 `finalizeTurn` 把该 `prosodyEmotion` 交给 `persona.advance`,情绪推进零漂移
