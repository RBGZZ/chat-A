## MODIFIED Requirements

### Requirement: TurnContext 由外壳填充回合上下文

`TurnContext` SHALL 由 `Conversation` 外壳在每回合开始时填充,携带回合执行所需上下文:用户输入 `userText`、token 回调 `onToken`、`turnId`、`correlationId`、外壳已开启的 `turnSpan`、回合起始时间 `turnStartMs`,以及一个只读依赖句柄 `deps`(回合体所需的 llm / memory / persona / tracer / sessionId 及协作件)。`TurnContext` MAY 携带可选 `signal?: AbortSignal`——由外壳从 `send` 的第三形参透传,供策略转交底层 LLM 调用以支持协作取消;缺省时回合不可取消(与现状等价)。策略 MUST 仅消费 `TurnContext` 中字段执行回合,MUST NOT 反向依赖 `Conversation` 实例内部(承 §3.1 接缝边界)。策略 MAY 经 `ctx.turnSpan` 设置回合级 span 属性(如情绪、命中观点数)。

#### Scenario: 由外壳注入上下文而非策略自取

- **WHEN** 外壳调用 `strategy.run(ctx)`
- **THEN** 策略经 `ctx` 取用 `userText`/`onToken`/`turnId`/`correlationId`/`turnSpan`/`turnStartMs`/`deps`,不直接访问 `Conversation` 私有字段

#### Scenario: 策略经 turnSpan 标注回合属性

- **WHEN** 策略在回合体内得到本轮情绪与命中观点数
- **THEN** 经 `ctx.turnSpan` 设置对应 span 属性,值与位置与现状一致

#### Scenario: 外壳经 ctx.signal 透传取消信号

- **WHEN** 调用方以 `send(userText, onToken, signal)` 传入 `AbortSignal`
- **THEN** 外壳把该 `signal` 填入 `TurnContext.signal`,策略可经 `ctx.signal` 取得同一实例;不传时 `ctx.signal` 为 `undefined`

### Requirement: SingleShotStrategy 承载现有单趟回合(对外等价)

系统 SHALL 提供默认实现 `SingleShotStrategy`,把现有 `Conversation.send()` 的回合体逐字迁入:读心情 → 分歧检测 → 组装 prompt → 开 `llm` 子 span 流式 LLM(累加 + `onToken`)→ 收尾(落历史、情绪推进、写记忆、决策 trace)。其行为、emit 的事件、`turn→llm` span 树、决策 trace 字段、流式 token 序列 MUST 与重构前**逐字一致**。`SingleShotStrategy` MUST 把 `ctx.signal` 透传给 `llm.stream(req, ctx.signal)`;当 `ctx.signal` 缺省时,该调用形状与行为 MUST 与现状等价(等同 `stream(req)`)。回合内既有的优雅降级(召回/情绪推进/记忆抽取/trace 写入吞错不打断回合,§3.2)MUST 原样保留;LLM 抛错时(含 abort 触发的 AbortError)MUST 沿用现状由外壳 catch 发 `turn:end{reason:'error'}` 并标 span ERROR 后重抛。

#### Scenario: 默认策略行为与现状等价

- **WHEN** 不注入自定义 `strategy`,以 `FakeLlm` 跑一个回合
- **THEN** 流式 token 拼回完整回复、落历史、emit 序 `['turn:start','turn:end']`、产出 `turn→llm` span 树、写一条含组装 system/recalled/emotion/provider/reply 的决策 trace,均与重构前一致

#### Scenario: 回合内降级原样保留

- **WHEN** appraiser / extractor / stanceDetector / traceSink 抛错
- **THEN** 回合不中断、仍返回回复并 emit `turn:end`,与现状降级行为一致

#### Scenario: signal 透传给 llm.stream

- **WHEN** 以带 `signal` 的 `TurnContext` 跑 `SingleShotStrategy`
- **THEN** `llm.stream` 收到的第二实参为 `ctx.signal` 同一实例;不带 signal 时第二实参为 `undefined` 且 token 序列与现状一致
