## 1. providers:FakeLlm.stream 尊重 signal

- [x] 1.1 写失败测试:`stream(req, signal)` 在 abort 后停止 yield(干净结束)
- [x] 1.2 实现:`stream(req, signal?)` 每次 yield 前自检 `signal?.aborted`,已 abort 则 return
- [x] 1.3 跑绿;确认既有 providers 测试零回归

## 2. runtime:Conversation.send + TurnContext.signal 透传

- [x] 2.1 写失败测试:`send(text, onToken, signal)` 把 signal 填入 `TurnContext.signal`(自定义策略断言同一实例)
- [x] 2.2 写失败测试:不传 signal 时 `ctx.signal === undefined` 且行为与现状一致
- [x] 2.3 实现:`TurnContext` 加可选 `signal?`;`send` 加可选第三形参并填入 ctx
- [x] 2.4 跑绿

## 3. runtime:SingleShotStrategy / ToolCallingStrategy 透传到 LLM

- [x] 3.1 写失败测试:带 signal 跑 SingleShot → `llm.stream` 第二实参为同一 signal;不带 → undefined
- [x] 3.2 实现:`stream(req, ctx.signal)`;ToolCalling `completeWithTools(req, ctx.signal)` + 降级透传 ctx
- [x] 3.3 实现完成
- [x] 3.4 写失败测试:abort 后 LLM 流停止,回合经外壳 catch 发 turn:end{error} 重抛(不崩)
- [x] 3.5 跑绿

## 4. runtime:VoiceLoop per-turn AbortController + interrupt abort

- [x] 4.1 扩展注入 send 签名为 `(text, onToken, signal?) => Promise<string>`
- [x] 4.2 写失败测试:打断时本回合 signal 变 aborted(注入 send 捕获 signal 断言)
- [x] 4.3 实现:`#startThinking` 建 AbortController 传入 send;`#interrupt`/`stop` 调 abort()
- [x] 4.4 写测试:abort 后半句写回 + 回 listening + 旧 gen 帧不再下行(与现状一致);send AbortError reject 不重复 reset
- [x] 4.5 跑绿

## 5. 验收

- [x] 5.1 `pnpm -C packages/runtime typecheck && pnpm -C packages/runtime test` 全绿(75 测试)
- [x] 5.2 全仓 `pnpm -r --if-present typecheck` 与 `pnpm test` 全绿、零回归(854 测试)
- [x] 5.3 `openspec validate conversation-abort-signal --strict` 通过
