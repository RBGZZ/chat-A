# 设计:prosody-pad-bridge

承 `prosody-stt-emotion`(已合并)留下的最后一截桥接。两块积木已就位:
- persona 侧:`prosodyToPadPull(emotion?: SttEmotionLike): PadPull` + `DEFAULT_PROSODY_PAD_MAP`(纯函数,确定性内核)。
- providers 侧:`SttResult.emotion?: SttEmotion`(qwen-asr 填,其余恒 undefined)。

本 change 只做**通路串联**:STT 情绪 → voice-loop → conversation → strategy → finalizeTurn → `persona.advance` 合并入 PAD。

## §1 persona.advance 合并语音拉力(主接缝)

`engine.ts` 现状:`advance(userText)` 内 `pull = await appraise(...)` → `stepPad({pull, ...})`。

改为:
```ts
const PROSODY_PULL_WEIGHT = 0.5; // 外置具名常量:语音为辅不盖文本(§7#5)

async advance(userText: string, opts?: { prosodyEmotion?: SttEmotionLike }): Promise<void> {
  ...
  const textPull = await this.#appraiser.appraise({ userText, pad, turn });
  const pull = mergePull(textPull, opts?.prosodyEmotion); // 无 emotion → 返回 textPull 原物
  const pad = stepPad({ pull, ... });   // 单次步进,与现状同一次
}
```

`mergePull(textPull, emotion?)`:
- `emotion === undefined` → **直接返回 textPull**(同一对象,字面零改动,回归硬线)。
- 否则 `prosodyPull = prosodyToPadPull(emotion)`;各维 `clampUnit(textPull.axis + W * prosodyPull.axis)`。
  - 因 `prosodyToPadPull` 对 neutral/未知/缺省返回零拉力,故 neutral 标签合并后 === textPull(行为等价不提供)。

**关键不变式**:无论是否传 prosody,**只有一次 stepPad**(不二次步进、不二次基线回归)——语音只改「这一次步进用什么 pull」。

`SttEmotionLike` 已在 `prosody.ts` 定义并经 index 导出;`advance` 入参直接复用它,persona 不依赖 providers。

## §2 线程穿透(全可选,exactOptionalPropertyTypes 友好)

链路:`Conversation.send(text, onToken, signal?, prosodyEmotion?)`
→ 填 `TurnContext.prosodyEmotion?`(条件展开 `...(prosodyEmotion ? { prosodyEmotion } : {})`)
→ 策略解构 `ctx.prosodyEmotion`,经 `finalizeTurn` args 条件展开透传
→ `finalizeTurn` 内:`prosodyEmotion ? advance(userText, { prosodyEmotion }) : advance(userText)`。

- `TurnContext` 加 `readonly prosodyEmotion?: SttEmotionLike`(runtime 从 `@chat-a/persona` import 该类型——persona 已是 runtime 既有依赖)。
- 两策略(single-shot 在 conversation.ts、tool-calling 在 tool-calling-strategy.ts)都解构 `prosodyEmotion` 并在调 `finalizeTurn` 时条件展开,确保零漂移。
- `finalizeTurn` 第 167 行 `await deps.persona.advance(args.userText)` 改为按 `args.prosodyEmotion` 是否存在分流(仍包在既有 try/catch 降级里)。

## §3 voice-loop 捕获情绪

- `#transcribe(buf)` 现返回 `string`;改为返回 `{ text: string; emotion?: SttEmotion }`,迭代时取最终 `SttResult` 的 `emotion`(与 text 同一条 final;无 final 取 lastAny 那条)。
- `SendFn` 类型(`VoiceLoopDeps.send` 与 `#send` 字段)加可选第 4 参 `prosodyEmotion?: SttEmotionLike`。
- `#startThinking`:`const { text, emotion } = await this.#transcribe(buf)`;调 `this.#send(text, onToken, ac.signal, emotion)`(emotion 缺省即 undefined,装配的 `conversation.send.bind` 第 4 参缺席)。
- voice-loop 从 `@chat-a/providers` 已 import `SttProvider/TtsProvider/PcmChunk`,补 import `SttEmotion`;`SttEmotionLike` 从 `@chat-a/persona` import(用于 SendFn 第 4 参类型,与 conversation 对齐;`SttEmotion` 结构上满足 `SttEmotionLike`)。
- omni 直路**不经此**(omni 不走 STT;omni 情绪后续单独接)——`#startThinkingOmni` 不变。

## §4 可追溯(§8.1)

`finalizeTurn` 写 trace 时,若 `args.prosodyEmotion` 存在则附 `prosodyEmotion: args.prosodyEmotion.label`(经既有 `deps.traceSink.record`;DecisionTrace 类型若不含该字段则仅做最小处理——不强依赖,缺省 Noop sink 不写)。为避免改 observability 包类型造成跨包改动,trace 侧采**软附带**:仅在 record 调用对象上条件展开,不新增必填字段。若 strict 类型不允许额外字段,则退化为不附带(本 change 不以 trace 字段为硬交付,核心是 PAD 影响)。

## §5 测试(不触网)

- persona `engine.test.ts`/新增:注入零拉力 appraiser,`advance(t, {prosodyEmotion:{label:'sad'}})` 后 pleasure 低于 `advance(t)`;`advance(t, {prosodyEmotion:{label:'neutral'}})` 与 `advance(t)` 全等;无 opts golden 与现状全等。
- runtime `turn-strategy`/`tool-calling`:自定义 persona stub 捕获 advance 的 opts,断言带 prosodyEmotion 跑两策略时 stub 收到同一值,不带时收到 undefined。
- runtime `voice-loop`:FakeStt script 带 `emotion` → 断言注入的 send 第 4 参收到该 emotion;script 无 emotion → 第 4 参 undefined。
- **默认无 prosody 全链路回归绿**:既有 persona/runtime/client 测试不改、全绿。

## 边界

只改 `packages/persona/src/engine.ts` + `packages/runtime/{conversation.ts, turn-shared.ts, tool-calling-strategy.ts, voice-loop.ts}` + 测试。不碰 providers/voice-detect/gateway/interaction/memory/cognition 内部。
