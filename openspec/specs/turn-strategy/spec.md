# turn-strategy Specification

## Purpose
TBD - created by archiving change turn-strategy. Update Purpose after archive.
## Requirements
### Requirement: TurnStrategy 回合执行接缝

系统 SHALL 提供 `TurnStrategy` 接缝:`run(ctx: TurnContext): Promise<string>`,描述"一个回合体如何执行"。`run` MUST 返回本回合的最终回复文本;MUST NOT 自行 emit 回合生命周期事件(`turn:start`/`turn:end`)或开启 `turn` span——这些由 `Conversation` 外壳负责。"回合具体怎么跑"(读心情、分歧检测、组装 prompt、流式 LLM、收尾落库)MUST 经实现 `TurnStrategy` 承载;不同回合范式(单趟 / 后续 Agent loop)MUST 各实现为一个策略,经注入替换而不改外壳。

#### Scenario: 策略产出回复文本

- **WHEN** `Conversation` 外壳以一个 `TurnContext` 调用 `strategy.run(ctx)`
- **THEN** 策略执行回合体并返回回复字符串,该字符串作为 `send()` 的返回值

#### Scenario: 生命周期事件不由策略发出

- **WHEN** 一个回合执行
- **THEN** `turn:start` / `turn:end` 与 `turn` span 由 `Conversation` 外壳发出,策略 `run` 不负责发出它们

### Requirement: TurnContext 由外壳填充回合上下文

`TurnContext` SHALL 由 `Conversation` 外壳在每回合开始时填充,携带回合执行所需上下文:用户输入 `userText`、token 回调 `onToken`、`turnId`、`correlationId`、外壳已开启的 `turnSpan`、回合起始时间 `turnStartMs`,以及一个只读依赖句柄 `deps`。`TurnContext` MAY 携带可选 `signal?: AbortSignal`(承现有协作取消)。`TurnContext` MAY 携带可选 `prosodyEmotion?: SttEmotionLike`——由外壳从 `send` 的第四形参透传,供策略经 `finalizeTurn` 转交 `persona.advance` 作为语音情绪拉力来源(§7#5);缺省时该字段为 `undefined`,回合的情绪推进与现状逐字一致。策略 MUST 仅消费 `TurnContext` 中字段执行回合,MUST NOT 反向依赖 `Conversation` 实例内部(承 §3.1 接缝边界)。

#### Scenario: 外壳经 ctx.prosodyEmotion 透传语音情绪

- **WHEN** 调用方以 `send(userText, onToken, signal?, prosodyEmotion)` 传入 prosody 情绪
- **THEN** 外壳把该 `prosodyEmotion` 填入 `TurnContext.prosodyEmotion`,策略可经 `ctx.prosodyEmotion` 取得同一值;不传时 `ctx.prosodyEmotion` 为 `undefined`

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

### Requirement: Conversation 外壳委托回合体且公开契约不变

`Conversation` SHALL 退守为回合外壳:保留生命周期、总线 `turn:start`/`turn:end`、`correlationId` 生成、OTel `turn` span 与 `chat_a.*` 关联属性、依赖装配;把回合体委托给注入的 `TurnStrategy`(缺省 `SingleShotStrategy`)。`Conversation` 的公开 API MUST 逐字不变:`ConversationDeps` 仅 MAY 新增可选 `strategy?: TurnStrategy`,其余构造参数、`send(userText, onToken)` 签名与行为、emit 的事件、决策 trace 字段全部不变,使 `packages/client/src/cli.ts` 与所有现有测试零改动仍通过。本变更 MUST NOT 改动记忆 / 人格 / trace 的读写路径或持久化 schema,MUST NOT 改动 `packages/runtime` 以外的任何包。

#### Scenario: 公开 API 逐字不变

- **WHEN** 既有调用方按原 `ConversationDeps`(不含 `strategy`)构造并调用 `send(userText, onToken)`
- **THEN** 编译通过、行为与事件与重构前一致,无需改动调用方代码

#### Scenario: correlationId 与生命周期仍由外壳产出

- **WHEN** 连续跑两个回合
- **THEN** 外壳产出 `turn:start`/`turn:end` 且 `correlationId` 递增(如 `s1/t1/0`、`s1/t2/0`),与现状一致

### Requirement: 注入自定义 TurnStrategy 可替换回合执行

`Conversation` SHALL 支持经 `ConversationDeps.strategy` 注入自定义 `TurnStrategy` 替换回合体;注入后,回合执行走自定义策略,而外壳的生命周期(`turn:start`/`turn:end`、`turn` span、`correlationId`)MUST 照常运转。这是 §9 P3 Agent loop 的挂载点:Agent loop 作为另一个 `TurnStrategy` 挂到同一外壳即可,无需改动 `Conversation` 外壳。

#### Scenario: 自定义策略替换回合体

- **WHEN** 注入一个自定义 `TurnStrategy`(其 `run` 不调用默认 LLM 流程、返回自定义回复)并调用 `send()`
- **THEN** 返回值来自自定义策略、默认单趟流程未被执行,而外壳仍 emit `turn:start`/`turn:end` 且 `correlationId` 正常

#### Scenario: 外壳生命周期与自定义策略解耦

- **WHEN** 自定义策略 `run` 内只回调若干 `onToken` 并返回
- **THEN** `onToken` 收到的 token 来自自定义策略,且外壳照常完成 `turn:start`→`turn:end` 生命周期

### Requirement: 回合收尾在两策略间零漂移并可携带 prosody 情绪

`SingleShotStrategy` 与 `ToolCallingStrategy` MUST 共用 `turn-shared` 的 `finalizeTurn` 完成回合收尾(落历史、情绪推进、写记忆、决策 trace),使工具回合与单趟回合的记忆/人格/trace 逐字零漂移。`finalizeTurn` 的 args MAY 携带可选 `prosodyEmotion?: SttEmotionLike`;提供时 `finalizeTurn` MUST 调 `deps.persona.advance(userText, { prosodyEmotion })`(仅在提供时带 opts),否则调 `deps.persona.advance(userText)`(与现状逐字一致)。两个策略 MUST 把各自 `ctx.prosodyEmotion`(若有)经 `finalizeTurn` args 透传,确保 STT 路语音情绪在两种回合范式下都能影响心情。当 `prosodyEmotion` 缺省时,情绪推进调用形状与行为 MUST 与现状等价。`finalizeTurn` 写决策 trace 时 MAY 在提供 `prosodyEmotion` 时附带其 `label`(纯加法,经既有 traceSink 接缝)。

#### Scenario: SingleShot 透传 prosodyEmotion 到 advance

- **WHEN** 以带 `prosodyEmotion` 的 `TurnContext` 跑 `SingleShotStrategy`
- **THEN** `finalizeTurn` 以 `persona.advance(userText, { prosodyEmotion })` 推进情绪;不带时以 `persona.advance(userText)` 推进,与现状一致

#### Scenario: ToolCalling 与 SingleShot 同源透传

- **WHEN** 以带同一 `prosodyEmotion` 的 `TurnContext` 分别跑两策略
- **THEN** 两者都经 `finalizeTurn` 把该 `prosodyEmotion` 交给 `persona.advance`,情绪推进零漂移

