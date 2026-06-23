## Context

打断(barge-in)目前是「协作式放弃」:VoiceLoop 用 `#gen++` 让在途回合的 `onToken`/`#speak`
自检失败而 no-op,但注入的 `send` 不可取消,底层 LLM 在后台跑到完。`LlmProvider` 接缝早已带
`signal?: AbortSignal`,真 Provider 已透传到 SDK。缺的是上游串联与 VoiceLoop 的 AbortController。

## Goals / Non-Goals

- Goals:把 `AbortSignal` 从 VoiceLoop 串到 `Conversation.send` → `TurnContext` → 策略 →
  `llm.stream`/`completeWithTools`;barge-in `abort()` 使 LLM 流真停;取消优雅收尾不崩回合。
- Non-Goals:改 Provider 接缝;STT/TTS 取消;真模型端到端验证。

## Decisions

### 1. signal 透传路径(全程可选,向后兼容)
`Conversation.send(userText, onToken, signal?)` → 填入 `TurnContext.signal` →
`SingleShotStrategy`/`ToolCallingStrategy` 把 `ctx.signal` 透传给
`deps.llm.stream(req, ctx.signal)` / `deps.llm.completeWithTools(req, ctx.signal)`。
- 全链 `signal?` 可选;不传时所有调用形状与现状一致(`stream({system,messages})`、
  `stream({system,messages}, undefined)` 行为等价)。
- `TurnContext.signal` 用 `readonly signal?: AbortSignal`,只在提供时填(`exactOptionalPropertyTypes`
  友好:`...(signal ? { signal } : {})`)。

### 2. 取消 = LLM 流抛错 → 外壳 catch(沿用现状,不新增分支)
abort 后 `for await` 循环抛(FakeLlm 干净结束/真 Provider 抛 AbortError)。沿用现有
「LLM 子 span catch → 重抛 → turn 外壳 catch → emit turn:end{error}」范式。**不在 Conversation
层把 AbortError 转成正常返回**——因为:
- VoiceLoop 才是取消的发起方,它已用 `#gen` 把本回合标记作废:send rejects 后走
  `.catch`,且 `gen !== this.#gen` 时**不** resetToListening(打断已自行迁移到 listening),
  半句也已在 `#interrupt` 里写回。故 reject 不会污染状态。
- 这样回合体逻辑零改动,SingleShot/ToolCalling 等价基线不破。

### 3. FakeLlm.stream 尊重 signal(测试可断言「真停止」)
`stream(req, signal?)`:每次 yield 前检查 `signal?.aborted`,若已 abort 则**停止 yield 干净
返回**(不抛)。这足以让测试断言:abort 后不再有新 token,且循环结束。
- 选择「干净结束」而非「抛 AbortError」:FakeLlm 是确定性桩,干净结束更简单且不需要在
  Conversation 层加 abort 容错;真 Provider 的 SDK 行为(抛 AbortError)由外壳现有 catch 兜住。
- `complete`/工具通道桩:本切片测试不需要,保持不变(仅 stream 加 signal 自检即可覆盖目标场景)。

### 4. VoiceLoop:per-turn AbortController + interrupt abort
- `#startThinking` 内每回合 `const ac = new AbortController()`,存到字段 `#currentAbort`,
  调用 `this.#send(text, onToken, ac.signal)`。
- `#interrupt`(barge_in_pending→listening)里在 `#gen++` 之后 `this.#currentAbort?.abort()`,
  使底层 LLM 流停止。`stop()` 同样 abort(作废在途回合时一并真停)。
- abort 后 send rejects,`.catch` 里因 `gen !== #gen` 不 reset(打断已迁移),与现状半句写回/
  作废逻辑完全兼容。注入 send 签名扩展为 `(text, onToken, signal?) => Promise<string>`。

## Risks / Trade-offs

- send reject 噪声:打断后 send 以 AbortError reject,`.catch` 里会 `console.warn`。为避免把
  「正常取消」当错误刷屏,`.catch` 仅在 `gen === #gen` 时 warn+reset(被打断的回合静默忽略)。
- 不传 signal 路径必须逐字等价:以现有全套 runtime/providers 测试 + 新增「不传 signal」断言守护。

## Migration Plan

纯加法,无 schema/持久化变更。现有调用方(client cli)不改即可编译(signal 可选)。
