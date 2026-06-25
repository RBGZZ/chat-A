## Context

omni 直路(path B)`#startThinkingOmni`(`packages/runtime/src/voice-loop.ts`)消费 `omni.respondToAudio` 的 `transcript`/`text`/`end`,**不调 `#send`**,因此 STT 路那条「emotion → `#send` 第 4 参 → `Conversation.send` → `persona.advance({prosodyEmotion})` → `prosodyToPadPull` 并入 PAD」的链路在 omni 路上**整条缺失**。`OmniEvent` 也无情绪字段。本设计按调研文档 `docs/multimodal-voice-emotion-investigation-2026-06-25.md` §5 P1 **方案 A(显式情绪标签协议)** 补齐,选 A 而非 B(读 omni 服务端原生情绪事件)的原因:A 复用全部现成纯函数(`prosodyToPadPull` / `persona.advance`),不依赖未经真机核实的 DashScope 情绪事件名/字段(项目纪律:别照搬 SDK 文档,以真机为准)。

现成可复用接缝:`prosodyToPadPull(SttEmotionLike)`(`packages/persona/src/prosody.ts`,7 类标签→PAD,neutral/未知/低 confidence 已内置零拉力降级);`PersonaEngine.advance(userText, {prosodyEmotion})`(`packages/persona/src/engine.ts`,空 userText 时 textPull 走 appraiser 但 prosody 拉力照并入);`SttEmotionLabel` 7 类集合(`packages/providers/src/stt.ts`);`Conversation.composeOmniInstructions()`(omni-only 系统提示组装,STT/文字路不经过)。

## Goals / Non-Goals

**Goals:**
- omni 路把用户语气情绪经 `[user_emotion:label-intensity]` 标签链路喂进 PAD,落地 §7 底线「prosody 永不漏听」。
- 标签**绝不**进 TTS / 显示气泡 / 半句写回记忆。
- 零回归:不注入钩子 / 无标签 / 解析失败 → omni 路逐字现状;现有所有测试仍绿。
- 复用 `prosodyToPadPull`,不新写情绪→PAD 映射。

**Non-Goals:**
- 不做 omni 路回合的 persona **全演化**(OCEAN delta)、**亲密度**推进、**助手回复写记忆**——本切片只补「情感→PAD」这一条。
- 不读 omni 服务端原生情绪事件(方案 B,留待真机核实后另议)。
- 不改 STT 路 / 文字路 / barge-in / EchoGuard / `#interrupt` / `#onAudio`。

## Decisions

### D1:标签格式 `[user_emotion:<label>-<intensity>]`

`label` ∈ 7 类(`surprised/neutral/happy/sad/disgusted/angry/fearful`,与 `SttEmotionLabel` 逐字一致),`intensity` ∈ 1–10 整数。解析正则 `/\[user_emotion:([a-z]+)-(\d{1,2})\]/gi`,取**最后一个**匹配。intensity → `confidence = clamp(intensity/10, 0, 1)`(喂 `SttEmotionLike.confidence`,`prosodyToPadPull` 线性缩放拉力)。label 不在 7 类内 → 视作无情绪(不调钩子 / 或调钩子但 `prosodyToPadPull` 自然零拉力——取**不调钩子**更省)。
- **为何 1–10**:与调研文档示例 `[user_emotion:sad-7]` 对齐,直观、好让模型遵从。
- **替代**:用 confidence 浮点——模型难稳定输出小数,弃。

### D2:注入点 = `Conversation.composeOmniInstructions` 末尾追加(不走 contributor)

在 `composeOmniInstructions` 取得 `assembled.system` 后,追加一段导出的常量指令 `OMNI_USER_EMOTION_DIRECTIVE`(runtime 侧单一真相源)。
- **为何不加 contributor**:contributor 跑在 `composeSystem` 里,而 `composeSystem` 被 `Conversation.send`(STT/文字路)**共用** —— 加 contributor 会污染文字回复(把标签指令带进所有文本回合)。除非新增一个 omni-only 开关贯穿 PromptContext + assembler,改面过大。直接在 omni-only 的 `composeOmniInstructions` 末尾追加,**天然 omni 限定、改面最小、零风险**。
- 指令文案:中文,明确「在回复**最后**单独附一个标签 `[user_emotion:标签-强度]`,标签从这 7 个里选…强度 1–10;这个标签只给程序读、不要在正文里提它」。

### D3:剥标签的流式安全 —— 纯函数 `stripUserEmotionTag` + 喂句前 hold-back

标签在回复**尾部**且不含句末标点,`SentenceSplitter` 不会在标签处切句:正文 `…！` 先成句喂 TTS,标签 `[user_emotion:…]` 留在 splitter 缓冲 → `flush()` 会把它当尾句念出来。故:
- 不把 `ev.text` 直接喂 splitter。改为维护一个 `pendingText` 缓冲:每来一段 `text` 增量,先 `pendingText += ev.text`,然后**只把「保证不可能再属于一个未完成标签的前缀」的安全部分**喂 splitter(hold-back:若 `pendingText` 末尾是 `[`、`[u`、…`[user_emotion:happy-` 这类**可能是半截标签**的前缀,就把这段尾巴留住不喂,等后续 token)。判定用一个纯函数 `splitSafeTextForTag(pending) → { emit, hold }`。
- 收到 `end` / 流结束时:对 `pendingText`(此时含完整标签或残余)调 `stripUserEmotionTag` 得 `{ cleanText, emotion }`,把 `cleanText` 中尚未 emit 的部分喂 splitter,再 `flush`;并据 `emotion` 调 `advanceProsody`。
- `#replyAccum`(供半句写回)同样累积**剥标签后**的干净文本——保证打断时写回不含标签。
- **替代**:正则只在 flush 时剥——会漏掉「标签前缀已被当普通尾巴 emit 给 TTS」的边角;hold-back 更稳。两个纯函数都 golden-test。

### D4:钩子 `advanceProsody?` + `Conversation.advanceProsody` 方法

VoiceLoop deps 新增 `advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>`(exactOptional 风格,镜像 `composeOmniInstructions?`)。`Conversation` 新增 `advanceProsody(emotion)` 方法,内部调 `this.#deps.persona.advance('', { prosodyEmotion: emotion })`——用**与 `send` 同一个** persona 实例(单一 PAD 真相源,避免装配层另起 PersonaEngine 双步进)。装配层(cli-voice `VoiceModeDeps` + app.ts)以 `(e) => convo.advanceProsody(e)` 注入,镜像现有 `composeOmniInstructions: () => convo.composeOmniInstructions()`。
- 调用点:在 omni 回合 `end`/收尾处(标签解析完)调一次,`void` 化 + try/catch 吞错(§3.2,不阻塞收尾、不崩)。空 userText 进 `advance` 会让 appraiser 对空串打分(拉力近零)再并入 prosody 拉力——可接受,且与「prosody-only 推进」语义一致。

## Risks / Trade-offs

- **模型不输出标签 / 格式跑偏** → `stripUserEmotionTag` 解析不到 → 不调钩子(零情绪降级),omni 路逐字现状;不崩、不漏标签进 TTS。正则容错(大小写不敏感、容忍多标签取最后)。
- **空 userText 进 `persona.advance` 触发 appraiser 调用** → appraiser 对空串通常近零拉力;若 appraiser 实现昂贵,可后续加 prosody-only 短路,但本切片复用现成 advance(不新写映射,符合约束)。
- **hold-back 在极端分块下多留一两字符到 flush** → 可接受(首音延迟无影响,正文照常按句出);纯函数保证不漏标签。
- **desktop 是否复用同套 omni 装配** → 若 desktop 走 `startVoiceMode` 同一 `VoiceModeDeps`,接线一处即覆盖;若另有装配点则一并接。实施时核实 `packages/desktop/src/main.ts`。

## Migration Plan

纯加法、无 schema 变更、无数据迁移。回滚 = 不注入钩子(运行时即回退);代码层回滚则 revert 本 change 的提交。

## Open Questions

- intensity → confidence 是否需要非线性(强情绪更可信)?本切片用线性 `/10`,真机标定后可调(行为即配置)。暂不引入旋钮。
