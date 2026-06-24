## 1. persona:advance 合并可选 prosody 拉力

- [x] 1.1 写失败测试(`engine.test.ts` 或新测):零拉力 appraiser + `advance(t, {prosodyEmotion:{label:'sad'}})` → pleasure 低于 `advance(t)`
- [x] 1.2 写测试:`advance(t, {prosodyEmotion:{label:'neutral'}})` 与 `advance(t)` 产出 PAD/turn 全等(降级等价)
- [x] 1.3 写测试(golden):无 opts 的 `advance(t)` 推进结果与现状逐字一致(纯加法回归)
- [x] 1.4 实现:`advance(userText, opts?)`;外置 `PROSODY_PULL_WEIGHT=0.5`;`mergeProsodyPull(textPull, emotion?)`(无 emotion 返回 textPull,有则各维 `clampUnit(text + W*prosody)`);单次 stepPad
- [x] 1.5 跑绿;确认 persona 既有测试零回归

## 2. runtime:TurnContext + 两策略 + finalizeTurn 透传 prosodyEmotion

- [x] 2.1 写失败测试(`prosody-pad-bridge.test.ts`):persona 经持久化 PAD 验证;带 prosodyEmotion 跑 SingleShot → PAD 偏移;不带 → 与现状一致
- [x] 2.2 写失败测试:ToolCalling 同样把 prosodyEmotion 经 finalizeTurn 交给 advance(PAD 偏移)
- [x] 2.3 实现:`TurnContext` 加 `prosodyEmotion?: SttEmotionLike`(import 自 `@chat-a/persona`);两策略解构并条件展开进 finalizeTurn args
- [x] 2.4 实现:`finalizeTurn` args 加 `prosodyEmotion?`;按其有无分流 `advance(t,{prosodyEmotion})` / `advance(t)`(仍在 try/catch 降级内);turn span 标 `chat_a.prosody_emotion` label(经既有 OTel 接缝,不改 trace schema)
- [x] 2.5 跑绿

## 3. runtime:Conversation.send 第 4 参 + voice-loop 捕获情绪

- [x] 3.1 写失败测试(`prosody-pad-bridge.test.ts`):FakeStt script 带 `emotion` → 注入 send 第 4 参收到该 emotion;无 emotion → undefined
- [x] 3.2 写失败测试:`Conversation.send(t, onToken, signal, prosodyEmotion)` 把 prosodyEmotion 填进 TurnContext(自定义策略断言)
- [x] 3.3 实现:`Conversation.send` 加可选第 4 参 `prosodyEmotion?`,条件展开进 strategy.run ctx
- [x] 3.4 实现:`SendFn` 类型(`VoiceLoopDeps.send` 与 `#send`)加可选第 4 参;`#transcribe` 返回 `{text, emotion?}`;`#startThinking` 取 emotion 经 `#send` 透传;omni 路不变
- [x] 3.5 跑绿

## 4. 验收

- [x] 4.1 `pnpm -C packages/persona typecheck` + `pnpm -C packages/runtime typecheck` 全绿
- [x] 4.2 全仓 `pnpm -r typecheck` 与 `npx vitest run` 全绿、零回归(1269 测试全过,含默认无 prosody 全链路回归绿)
- [x] 4.3 `openspec validate prosody-pad-bridge --strict` 通过
