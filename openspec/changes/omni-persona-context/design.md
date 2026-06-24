# 设计:omni 直路携带组装好的系统提示

## 影响的 canonical 章节/接缝

- §4 双路径(path B audio-in 直路)/ §5.4 分两档注入(system 段组装)/ §6 人格 / §7#5 prosody。
- §5.5 非阻塞召回硬约束:omni 首音前的 instructions 组装不得焊死外部阻塞调用。
- §3.2 优雅降级:compose 未注入/失败/超时 → 最小 persona 提示或空,绝不崩、不阻塞。

## 接缝形状(为什么这样切)

omni 直路在 runtime,prompt 组装在 cognition + Conversation(turn-shared 的 `composeSystem`)。
runtime 不应反向依赖 Conversation 内部(§3.1)。故采用**装配层注入闭包**的接缝,而非在 runtime 里
重造 prompt 组装:

```
VoiceLoopDeps.composeOmniInstructions?: () => string | Promise<string>
        │  (cli-voice 透传)
        ▼
cli.ts:  () => convo.composeOmniInstructions()
        │  (复用 Conversation 内部 #deps + composeSystem,只读式)
        ▼
Conversation.composeOmniInstructions(): Promise<string>
   └─ 复用 mood(closeness→tone) + detectStance + composeSystem → 取 assembled.system
```

- **复用而非重造**:`composeOmniInstructions` 内部完全走 STT 路同一套(`persona.tone`、`detectStance`、
  `composeSystem` → `assembler.assemble`),只是 `userText=''`(omni 无本轮文本)、不要 messages、
  只取 `system` 字符串。persona/memory/tone/立场/风格纪律一字不差地复用,零漂移。
- **空 query 组装**:omni 是「音频进、模型直接听」,这轮用户说了什么由模型自己听,故组装时不带 transcript。
  记忆召回以空 query 调 `composeSystem`(走既有关键词快路径;命中近期/置顶记忆即注入,空命中即不注入块,
  与现状降级一致)。不启用语义嵌入(omni 首音前不引新的网络阻塞,§5.5)。

## VoiceLoop 侧:在 `#startThinkingOmni` 先 compose 再 respondToAudio

```
const instructions = await this.#composeOmniInstructionsSafe(); // 未注入→undefined;失败→undefined
const opts = instructions !== undefined ? { instructions } : {};
for await (const ev of omni.respondToAudio(toChunks(), opts, ac.signal)) { ... }
```

- `#composeOmniInstructionsSafe()`:未注入 → 返回 undefined(等价现状空 opts);注入则 `await` 之,
  **try/catch + 空串视作无**:抛错/超时/空 → 返回 undefined(退回空 opts),记 warn,绝不崩、不阻塞回合。
- compose 在 `toChunks()` 之前、`respondToAudio` 之前 await,本就在「开 WS / 首音」前;失败立即兜底,
  不卡 omni 首音(§5.5)。被本回合 abort 后再 compose 完也无害(gen 自检在循环里兜)。

## 降级矩阵(§3.2)

| 情况 | 行为 |
|---|---|
| `composeOmniInstructions` 未注入 | 空 opts,omni 路与本变更前**逐字一致** |
| 注入但抛错/超时 | warn + 退回空 opts(不崩、不阻塞) |
| 注入返回空串 | 视作无,退回空 opts |
| `Conversation.composeOmniInstructions` 内部 composeSystem 抛错 | 兜底返回 persona 骨架(身份最小提示),不空、不抛 |
| STT 路 | 完全不经此接缝,零影响 |

## 备选与取舍

- ❌ 在 VoiceLoop 里直接依赖 cognition 的 PromptAssembler 重造组装:违反 §3.1(runtime 不依赖 cognition 组装内部),
  且会与 Conversation 的组装漂移(双套权威)。
- ✅ 注入闭包 + Conversation 暴露只读复用方法:零漂移、爆炸半径可控、runtime 不反向依赖。
