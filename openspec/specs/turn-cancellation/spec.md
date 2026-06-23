# turn-cancellation Specification

## Purpose
TBD - created by archiving change conversation-abort-signal. Update Purpose after archive.
## Requirements
### Requirement: Conversation.send 接受并透传 AbortSignal

`Conversation.send` SHALL 增加可选第三形参 `signal?: AbortSignal`,签名为
`send(userText, onToken, signal?)`。外壳 MUST 把该 `signal` 经 `TurnContext.signal` 透传给
注入的 `TurnStrategy.run`。不传 `signal` 时,`send` 的行为、emit 的事件、span 树、决策 trace 字段、
流式 token 序列 MUST 与本切片之前**逐字一致**(纯加法、向后兼容)。

#### Scenario: 不传 signal 行为不变

- **WHEN** 以 `FakeLlm` 调用 `send(userText, onToken)`(不传 signal)
- **THEN** 流式 token 拼回完整回复、emit 序 `['turn:start','turn:end']`、correlationId 与现状一致

#### Scenario: signal 经 TurnContext 透传给策略

- **WHEN** 注入一个自定义 `TurnStrategy` 并以 `send(userText, onToken, signal)` 调用
- **THEN** 策略经 `ctx.signal` 取到外壳传入的同一 `AbortSignal` 实例

### Requirement: TurnStrategy 透传 signal 到 LLM 调用

`SingleShotStrategy` 与 `ToolCallingStrategy` SHALL 把 `ctx.signal` 透传到底层 LLM 调用:
`SingleShotStrategy` MUST 调用 `llm.stream(req, ctx.signal)`;`ToolCallingStrategy` MUST 调用
`llm.completeWithTools(req, ctx.signal)`,且其降级到 fallback 策略时 MUST 透传同一 `ctx`(含 signal)。
当 `ctx.signal` 缺省(`undefined`)时,调用形状与行为 MUST 与现状等价。

#### Scenario: SingleShot 把 signal 传进 stream

- **WHEN** 以带 signal 的 `TurnContext` 跑 `SingleShotStrategy`,LLM 记录 `stream` 收到的 signal 实参
- **THEN** LLM 的 `stream` 第二实参为 `ctx.signal` 同一实例

#### Scenario: 缺省 signal 时 stream 调用等价

- **WHEN** 以不带 signal 的 `TurnContext` 跑 `SingleShotStrategy`
- **THEN** `stream` 第二实参为 `undefined`,token 序列与回复与现状一致

### Requirement: abort 后 LLM 流停止且回合优雅收尾

当透传的 `AbortSignal` 在 LLM 流进行中被 `abort()`,LLM 流 SHALL 停止产出后续 token。回合
MUST NOT 因 abort 抛出未捕获异常而崩溃:沿用现有「LLM 抛错由外壳 catch」范式——LLM 流抛错经 `llm`
子 span 记录并重抛,`Conversation` 外壳 catch 后 emit `turn:end{reason:'error'}` 并标 span ERROR。
`FakeLlm.stream` MUST 在每次 yield 前自检 `signal?.aborted`,已 abort 时停止 yield(干净结束),
不再产出后续 token。

#### Scenario: FakeLlm.stream 在 abort 后停止 yield

- **WHEN** 给 `FakeLlm.stream(req, signal)` 传一个在首 token 后被 abort 的 signal
- **THEN** abort 之后不再 yield 新 token,且流干净结束(不无限产出)

#### Scenario: abort 不致回合崩溃

- **WHEN** 在 `Conversation.send(...,signal)` 跑流式途中 `abort()`,LLM 抛错
- **THEN** 外壳 catch 该错误、emit `turn:end{reason:'error'}` 并重抛,进程不崩

### Requirement: VoiceLoop barge-in 触发底层 LLM 真取消

`VoiceLoop` SHALL 为每个「想」回合创建一个 `AbortController`,并把其 `signal` 传入注入的
`send(text, onToken, signal)`。注入的 `send` 签名 SHALL 扩展为
`(text, onToken, signal?) => Promise<string>`(`signal` 可选、向后兼容,`onToken` 流式不变)。
确认打断时(`#interrupt`,barge_in_pending→listening),`VoiceLoop` MUST 调用该 `AbortController`
的 `abort()`,使底层 LLM 流真正停止;`stop()` 作废在途回合时亦 MUST `abort()`。被打断的回合的
半句写回与 generation 作废逻辑 MUST 与现状一致(abort 导致 send reject 时不重复 reset 状态)。

#### Scenario: 打断时调用 abort 真停 LLM

- **WHEN** VoiceLoop 处于 speaking、用户插嘴触发 barge-in 打断
- **THEN** 本回合的 `AbortController.abort()` 被调用,注入 send 收到的 signal 变为 aborted

#### Scenario: abort 后半句写回与回 listening 不变

- **WHEN** 打断发生且本回合已累积半句回复
- **THEN** 半句仍按现状写回记忆(带 `[被用户打断]`)、状态回 listening、旧 gen 帧不再下行,与现状一致

