## Why

语音回合「想」这一步(`packages/runtime/src/voice-loop.ts`):用户插嘴(barge-in)打断时,目前只靠
单调 generation 计数(`#gen`)把旧回合的 onToken/TTS 输出**作废** + 排空音频缓冲,但底层 LLM
其实**还在后台跑到完**——既浪费算力(真 LLM 浪费尾部 token),也不是「真打断」。

`LlmProvider` 接缝(`llm.ts`)**早已铺好** `signal?: AbortSignal`(`stream`/`complete`/
`completeWithTools`/`streamWithTools`),真 Provider(Anthropic/OpenAI 兼容)也已把 signal
透传到底层 SDK。**缺口在上游没把 signal 串下去**:`Conversation.send` 与 `TurnStrategy`
没有 signal 形参,VoiceLoop 也没有为回合建 AbortController。

本切片把 AbortSignal 端到端串起来:`Conversation.send(text, onToken, signal?)` →
`TurnContext.signal` → `TurnStrategy.run` → `llm.stream(req, signal)` /
`llm.completeWithTools(req, signal)`;并让 VoiceLoop 在确认打断时 `abort()` 之,使底层 LLM
流**真正停止**。**纯加法、向后兼容**:不传 signal 时所有现有行为逐字一致。

## What Changes

- **`Conversation.send` 增加可选 `signal?: AbortSignal`**:`send(userText, onToken, signal?)`;
  经 `TurnContext.signal` 透传给注入的 `TurnStrategy.run`。不传时与现状逐字一致。
- **`TurnContext` 新增可选 `signal?: AbortSignal`**:外壳填充,策略消费。
- **`SingleShotStrategy` / `ToolCallingStrategy` 透传 signal**:把 `ctx.signal` 传到
  `llm.stream(req, signal)` / `llm.completeWithTools(req, signal)`(降级路径也透传)。
- **优雅收尾(§3.2)**:abort 导致 LLM 流抛 AbortError 时,沿用现有「LLM 抛错由外壳 catch」
  范式重抛;**已生成的半句仍按现有 generation/作废逻辑处理**——不因 abort 抛未捕获异常崩回合。
- **VoiceLoop 真取消**:每个「想」回合建一个 `AbortController`,把 `signal` 传进注入的
  `send`;确认打断(`#interrupt`,barge_in_pending→listening)时调 `abort()`,使底层 LLM 流停止。
  注入的 `send` 签名扩展为 `(text, onToken, signal?) => Promise<string>`(signal 可选向后兼容,
  onToken 流式不变)。
- **`FakeLlm.stream` 尊重 signal**:abort 后停止 yield(干净结束),用于测试断言「abort 后流停止」。

## Capabilities

### Added Capabilities
- `turn-cancellation`: 回合可经 `AbortSignal` 协作取消——`Conversation.send`/`TurnContext`/
  `TurnStrategy` 透传 signal 到 LLM 调用;VoiceLoop barge-in 触发底层 LLM 流真停止;取消优雅收尾。

### Modified Capabilities
- `turn-strategy`: `TurnContext` 新增可选 `signal`,`SingleShotStrategy`/`Conversation.send`
  接受并透传 signal;不传时行为与现状逐字一致(向后兼容,纯加法)。

## Impact

- **canonical 章节/接缝**:§3.1(Provider 接缝 signal 已就位,本切片补上游串联)、§3.2(优雅降级:
  abort 当作「被取消」而非「真错误」,半句按现有逻辑写回/作废,不崩回合)、§4(流式贯穿:打断真停流)。
- **代码(仅本切片范围)**:`packages/runtime/src/conversation.ts`(send/TurnContext/SingleShot)、
  `packages/runtime/src/tool-calling-strategy.ts`(透传)、`packages/runtime/src/voice-loop.ts`
  (per-turn AbortController + interrupt abort)、`packages/providers/src/fake-llm.ts`(stream 尊重 signal)、
  `packages/runtime/test` / `packages/providers/test`(新增取消测试)。
- **绝不改** `packages/client`、`packages/protocol`、`packages/voice-detect`。
- **依赖**:无新外部依赖(`AbortSignal`/`AbortController` 为 Node 标准)。
- **延迟预算(§3.2)**:不传 signal 零额外延迟;真取消反而省尾部算力。

## Non-goals

- 改 `LlmProvider` 接缝(signal 形参已存在,无需改接口)。
- STT/TTS 的取消串联(本切片只管「想」这一步的 LLM 真取消;TTS 已有 generation 作废,够用)。
- 真模型端到端取消验证(本切片以 FakeLlm 断言协作取消语义)。
