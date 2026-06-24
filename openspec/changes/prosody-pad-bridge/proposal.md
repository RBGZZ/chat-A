## Why

`prosody-stt-emotion`(已合并 master)铺好了两块积木:STT 侧 `SttResult.emotion?`(qwen-asr 会填)、persona 侧确定性纯函数 `prosodyToPadPull(emotion)`。但它**没接进 voice-loop/conversation/persona.advance**——「从语音读情绪」(§7#5)目前只是一条**断头通路**:STT 即便读出了语气情绪,也**不会影响小雪的心情**(PAD 内核只吃文本 appraiser 的拉力,听不见语气)。

本 change 补上**最后一截桥接**:把 STT 的 prosody 情绪从 voice-loop 一路穿透到 `PersonaEngine.advance`,在每回合收尾(§5.5 非首字热路径)与文本 appraiser 的拉力**按权重合并**后单次 `stepPad` 步进,使「怎么说的」真正影响心情重心。**全可选、纯加法**:不传 prosody 情绪(文字 CLI 路 / 既有 provider 恒 undefined)→ 全链路行为**逐字不变**(既有 runtime/persona/client 测试全绿是回归硬线)。

## What Changes

- **`PersonaEngine.advance` 接受可选 prosody**(`packages/persona/src/engine.ts`):`advance(userText, opts?: { prosodyEmotion?: SttEmotionLike })`。提供 `prosodyEmotion` 时,以 `prosodyToPadPull(opts.prosodyEmotion)` 得语音拉力,与 appraiser 的文本拉力 `textPull` **按权重合并**:`merged = textPull + W·prosodyPull`(各维钳制 `[-1,1]`),`W` 为外置具名常量 `PROSODY_PULL_WEIGHT`(默认 `0.5`,语音为辅不盖文本),再**单次** `stepPad` 步进。**无 opts → 与现状逐字一致**(`pull===textPull`,同一次 stepPad,无任何漂移)。
- **线程穿透**(全可选、`exactOptionalPropertyTypes` 友好,不传即缺席,`packages/runtime`):
  - `Conversation.send(userText, onToken, signal?, prosodyEmotion?)` → 填入 `TurnContext.prosodyEmotion?`。
  - 两个策略(`SingleShotStrategy` / `ToolCallingStrategy`)都把 `ctx.prosodyEmotion` 经 `finalizeTurn` 的 args 透传(共用 turn-shared,零漂移)。
  - `finalizeTurn` args 加可选 `prosodyEmotion?`,调 `deps.persona.advance(userText, { prosodyEmotion })`(仅在提供时带 opts)。
- **voice-loop 捕获情绪**(`packages/runtime/src/voice-loop.ts`):`#transcribe` 改为额外回传最终 `SttResult.emotion`(返回 `{ text, emotion? }`);STT 回合把它经注入的 `#send(text, onToken, signal, emotion)` 透传出去。`SendFn` 类型加可选第 4 参 `prosodyEmotion?`(纯加法,不传的旧实现仍可注入)。文字 CLI 路无音频情绪 → 不传 → 无感。
- **可追溯**(§8.1):`finalizeTurn` 在写决策 trace 时**若有** `prosodyEmotion` 则把 `emotion.label` 记进 trace(经既有 traceSink 接缝,缺省 Noop 不依赖;trace 字段纯加法)。

## 范围与 Non-goals

- **主战场**:`packages/persona/src/engine.ts` + `packages/runtime/{conversation.ts, turn-shared.ts, voice-loop.ts, tool-calling-strategy.ts}` + 各自测试。`SttEmotionLike` 用 persona 既有结构类型,**不依赖 providers**;voice-loop 的 emotion 来自 `SttResult`(已有字段)。
- **不碰** providers / voice-detect / gateway / interaction / cognition / memory **内部**(只调既有 API);`prosody.ts` / `stt.ts` 已就位,本 change 不改它们。
- **不发真网络**:测试全用 Fake(注入式),验证「prosodyEmotion 透传 + PAD 朝该情绪偏移」与「默认无 prosody 回归全等」。真 qwen-asr 情绪是否真影响心情留待真连验。
- **不进首字热路径**:合并/步进在 `finalizeTurn`(回合收尾,首字之后),承 §5.5 非阻塞精神;`prosodyToPadPull` 为 O(1) 纯函数。

## Capabilities

### Modified Capabilities

- `persona-emotion`: `PersonaEngine.advance` 在既有「文本拉力 → stepPad」基础上补**可选 prosody 通路**:提供 `prosodyEmotion` 时按外置权重 `W` 合并语音拉力与文本拉力后单次步进,使 §7#5「从语音读情绪」真正影响 PAD;不提供时与现状逐字一致(纯加法、向后兼容)。
- `turn-strategy`: `Conversation.send`/`TurnContext`/两策略/`finalizeTurn` 透传可选 `prosodyEmotion`,STT 路把语音情绪带到回合收尾喂 `persona.advance`;不传时全链路行为与现状等价。

## Impact

- **canonical 章节/接缝**:§7#5(从语音读情绪 prosody——补上断头通路)、§6.1(PAD `stepPad`/拉力合并,单一权威公式不漂移)、§5.5(在回合收尾做,不焊进首字延迟)、§3.1(persona 经结构类型不依赖 providers)、§3.2(无情绪信号优雅降级=零语音拉力)、§8.1(emotion.label 入 trace 可追溯)。与权威设计一致。
- **代码**:`packages/persona/src/engine.ts`(advance 加可选 opts + 合并)、`packages/runtime/src/{conversation.ts, turn-shared.ts, tool-calling-strategy.ts, voice-loop.ts}` + 测试。
- **延迟预算(§3.2)**:不传 prosody 零额外延迟;传时仅一次 O(1) 纯函数合并 + 同一次 stepPad,无新增 await、无热路径影响。
- **依赖**:无新外部依赖。

## Non-goals

- 改 `prosody.ts` / `stt.ts` / qwen-asr provider(积木已就位,本切片只做桥接)。
- omni 直路(path B)把音频情绪喂 PAD(omni 不经 STT;omni 路情绪后续单独接)。
- 真模型端到端验证(本切片以 Fake 断言透传与 PAD 偏移语义)。
