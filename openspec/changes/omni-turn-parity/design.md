## Context

omni 直路(path B,`CHAT_A_VOICE_PATH=omni`)的回合在 `VoiceLoop.#startThinkingOmni`(`packages/runtime/src/voice-loop.ts:701`)里**自带 LLM 生成**(`omni.respondToAudio` 一口吃掉 STT+LLM),因此它**不调** `#send`(=`conversation.send`)。STT/文字路的全套人格/记忆演化挂在 `Conversation.send → SingleShotStrategy.run → finalizeTurn`(`packages/runtime/src/turn-shared.ts:138`)收尾链上,omni 路整条绕过。

`finalizeTurn` 当前做的收尾(逐条对照 omni 路是否有):

| 收尾步骤 | finalizeTurn(STT/文字路) | omni 路现状 |
|---|---|---|
| 写 user 消息 `appendMessage(role:'user')` | ✅ | 🟡 手动写(在 `transcript` 事件里,`voice-loop.ts:749`) |
| 写 assistant 消息 `appendMessage(role:'assistant')` | ✅ | ❌ **完全没写**(只在被打断时写半句) |
| 文本情绪评估 `persona.advance(userText)`(appraiser→PAD) | ✅ | ❌(P1 只调 `advance('', {prosodyEmotion})`,**空 userText → appraiser 看不到内容**) |
| 语音 prosody 并入 PAD | ✅(`#send` 第 4 参) | 🟡 P1 经 `advanceProsody` 钩子(独立通道) |
| `writeMemories`(抽要点/存原话) | ✅ | ❌ |
| closeness 抬升 `bumpCloseness` | ✅ | ❌ |
| 立场演化 `selfNotionsManager.advance` | ✅ | ❌ |
| 自我一致性 Guard `checkSelfConsistency` | ✅ | ❌ |
| 决策 trace `traceSink.record` | ✅ | ❌ |
| 写侧 embedding(语义召回写路径) | ✅ | ❌ |

P1(`omni-prosody-to-pad`,已归档)只补了表中「语音 prosody 并入 PAD」这一行(经 `advanceProsody` 钩子 → `Conversation.advanceProsody(e)` → `persona.advance('', {prosodyEmotion})`)。**本变更(option B)补齐其余所有行**,且把 prosody 那行也收口进同一收尾,消除「两套 prosody 推进」漂移。

现成可复用接缝:`finalizeTurn(deps, args)`(全部收尾逻辑,各步已内置降级);`Conversation` 已持有装配好的 `#deps: TurnDeps`(`persona`/`memory`/`stanceDetector`/`selfNotionsManager`/`traceSink`/`embedder`/`selfConsistencyGuard`/`primaryPersonId` 等);`SttEmotionLike`(结构类型,§3.1 接缝边界);P1 的 `stripUserEmotionTag`/`splitSafeTextForTag`(剥标签,已在 `voice-loop.ts` 用上)。

## Goals / Non-Goals

**Goals:**
- omni 路回合收尾在「人格演化 + 记忆行为 + 可追溯」上与 STT/文字路**逐条对齐**(单一 PAD/记忆真相源):助手回复入记忆/召回、文本评估、closeness 抬升、立场演化、自我一致性、决策 trace、写侧 embedding。
- 语音 prosody 情绪经**同一条收尾**并入 PAD(与 STT 路同源),不再用 P1 的独立 `advanceProsody` 旁路 → 杜绝双步进漂移。
- omni 自带回复:收尾入口**不**调 LLM、不开 llm span、不重新生成。
- 零回归:STT/文字路 `send`/`finalizeTurn` 调用形状逐字不变;omni 路降级/未接新入口时干净收尾不崩(§3.2)。

**Non-Goals:**
- 不改 omni 路的 LLM 生成本身(仍由 `omni.respondToAudio`/`composeOmniInstructions` 负责)。
- 不读 omni 服务端原生情绪事件(P1 设计 §5 方案 B,留待真机核实)——本变更沿用 P1 的 `[user_emotion:...]` 标签链路作为 prosody 来源。
- 不改 STT 路/文字路/barge-in/EchoGuard/`#interrupt`/`#onAudio`/状态机。
- 不改 `Conversation.send` 公开签名(只**新增**方法,不动既有)。
- 不引入 Agent loop/工具策略到 omni 路。

## Decisions

### D1:候选接缝方案对比(核心取舍)

需要一个「外部已生成回复、只走收尾」的入口让 omni 路复用 `finalizeTurn`。三个候选:

#### 方案 A(**推荐**):`Conversation.finalizeExternalTurn(userText, reply, opts?)` 公共收尾方法

在 `Conversation` 新增方法:开 turn span(与 `send` 同款)、读 mood/closeness、`detectStance`、组装一份**仅供 trace/记忆所需的** system/messages(或在不需要时传精简占位),再调既有 `finalizeTurn`(传入 `userText`/`reply`/`prosodyEmotion`/`mood`/`stance`/`recalled`),**跳过** `llm` span 与 `llm.stream`。omni 路 `#startThinkingOmni` 在收尾处调 `convo.finalizeExternalTurn(transcript, cleanReply, {prosodyEmotion})`,经一个新可选钩子 `finalizeTurn?: (userText, reply, opts?) => Promise<void>` 注入 VoiceLoop(镜像现有 `composeOmniInstructions`/`advanceProsody` 接线)。

- **优点**:复用 `finalizeTurn` **全部** 收尾逻辑(单一真相源),omni 自带回复天然不触 LLM;接线与 P1 同构(装配层一行);收尾在回合末尾、非热路径;`finalizeTurn` 各步已降级。STT/文字路零触碰。
- **缺点**:`finalizeTurn` 现签名要 `recalled`/`mood`/`stance`/`system`/`messages`/`turn` 等 `send` 路算好的字段——`finalizeExternalTurn` 需自己补齐(mood/stance 可同源复算;`recalled` 可空数组或复用 `composeOmniInstructions` 的召回;`system`/`messages` 对 trace 有用但 omni 无真实 prompt,可填 omni instructions + 合成 messages 或留最小)。需小心 `turn` 序号来源(用 `Conversation` 内部 `#turnSeq`)。
- **取舍**:把「补齐 finalizeTurn 入参」的复杂度集中在一个新方法里,换取「收尾逻辑单一真相源、omni 路与 send 同源」——符合 §3.1 接缝/单一权威公式。**选它**。

#### 方案 B:给 omni 路装配一个「假 LLM = 回放 omni 文本」的 `conversation.send`

把 omni 已生成的 reply 包成一个 `LlmProvider`(`stream` 直接 yield 回放 reply 的 tokens),临时构造/切换一个用此假 LLM 的 `Conversation`,调其 `send(transcript, onToken, signal, prosodyEmotion)` 跑完整回合体。

- **优点**:**零新方法**——直接复用 `send → strategy → finalizeTurn` 整条,行为与 STT/文字路 100% 同源。
- **缺点(致命)**:① `send` 内部会**再开 llm span**、**重新走 composeSystem 组装 prompt + 召回**(omni 已经让模型听过音频生成了,这里又组装一遍 system/messages 纯属重复且语义错位——omni 的 system 是 `composeOmniInstructions`,不是 `composeSystem`);② 假 LLM 回放会**二次触发 onToken→TTS**(reply 已经流式喂过 TTS 了,会重复播放),除非把 onToken 设空——但那样 `send` 的流式语义形同虚设;③ 时序:omni 是「先流式出 reply 边播,end 后才收尾」,而 `send` 是「stream 边 onToken 边收 acc,完了 finalizeTurn」——硬塞会打乱 VoiceLoop 的 generation/打断自检。**副作用面大、易回归。弃。**

#### 方案 C:把 `finalizeTurn` 的收尾步骤抽成 `turn-shared` 的独立纯协调函数,VoiceLoop 直接调

让 VoiceLoop 不经 `Conversation`,直接 import `turn-shared` 的 `finalizeTurn` 并自己传 `TurnDeps`。

- **优点**:不动 `Conversation`。
- **缺点**:VoiceLoop(runtime 薄外壳,设计上**零依赖 Conversation 内部**,见 `voice-loop.ts:11` 注释)需要拿到 `TurnDeps`(persona/memory/stance/trace/embedder…)——这正是 `Conversation` 封装的内部依赖,直接捅给 VoiceLoop **破坏接缝边界**(§3.1),且 turn span/`#turnSeq`/correlationId 等生命周期归 `Conversation` 外壳。把这些泄漏到装配层会让 omni 装配臃肿且与 send 路真相源分裂。**弃**(C 的「抽公共收尾」思路被 A 以「方法封装在 Conversation 内」更干净地实现)。

**结论:选 A**。VoiceLoop 仍只经注入的窄接口(新增一个 `finalizeTurn?` 钩子)与外界打交道,Conversation 内部封装收尾依赖与生命周期,单一真相源。

### D2:`finalizeExternalTurn` 如何补齐 `finalizeTurn` 入参(不调 LLM)

`finalizeExternalTurn(userText, reply, opts?: { prosodyEmotion?: SttEmotionLike })` 内部:
1. 开 `turn` span + correlationId(与 `send` 同款,经 `#bus.runWithCorrelation` + `tracer.startActiveSpan('turn')`),emit `turn:start`/`turn:end`。**不**开 `llm` 子 span。
2. 读 `closeness`、`mood = persona.tone(closeness)`(与 `send` 回合前同源)。
3. `stance = detectStance(deps, userText)`(omni 现在有真 transcript,立场命中按真文本)。
4. `recalled`:为 trace/自我一致性需要,可走既有关键词召回 `deps.memory.recall(userText)`(非阻塞、同步快,§5.5);失败降级空数组。**不**启用语义嵌入查询(omni 收尾不引新网络阻塞)。
5. `system`/`messages`:omni 无 `composeSystem` 真 prompt;trace 落「omni 直路」可填 `composeOmniInstructions` 的 system + 合成的最小 messages(`[{role:'user',content:userText},{role:'assistant',content:reply}]`),或在 `finalizeTurn` 里把 system/messages 视作可选(小重构)。**取舍**:优先「填合成值」而非改 `finalizeTurn` 签名,改面更小;若 trace schema 强约束则做 `finalizeTurn` 入参可选化的小重构。
6. `turn` 序号:用 `Conversation` 内部 `#turnSeq`(与 send 共享,自增)。
7. 调 `finalizeTurn(deps, { userText, reply, prosodyEmotion?, mood, stance, recalled, system, messages, turn, turnId, correlationId, turnSpan, turnStartMs })`——**完全复用**写双消息 + 文本评估 + prosody 并入 + writeMemories + closeness + 立场 + 自我一致性 + trace + 写侧 embedding。
8. 整体 try/catch:任一步失败记 warn 不抛(§3.2),omni 回合收尾已在 VoiceLoop 侧 `void` 化。

### D3:prosody 情绪收口 —— 取代 P1 的 `advanceProsody` 旁路

P1 的 `advanceProsody(e)` 单独调 `persona.advance('', {prosodyEmotion:e})`(只推 PAD)。本变更后 prosody 经 `finalizeExternalTurn` 的 `opts.prosodyEmotion` → `finalizeTurn` → `persona.advance(userText, {prosodyEmotion})`(**真 userText + prosody 一次合并并入**,与 STT 路同源)。

- **决定**:omni 路收尾**只调一次** `finalizeExternalTurn`(含 prosody),**不再**调 `advanceProsody`。避免「先 `advanceProsody` 推一次 PAD、`finalizeExternalTurn` 又 `persona.advance` 推一次」的**双步进**。
- **`advanceProsody` 钩子去留**:倾向**废弃**该 VoiceLoop 钩子与 `Conversation.advanceProsody` 方法(其语义被 `finalizeExternalTurn` 完全覆盖)。但 P1 的标签**剥离**纯函数(`stripUserEmotionTag`/`splitSafeTextForTag`)与 instructions 指令(`OMNI_USER_EMOTION_DIRECTIVE`)**保留**——它们仍是 prosody 情绪的来源,只是出口从 `advanceProsody` 改接到 `finalizeExternalTurn` 的 `prosodyEmotion`。
- **开放点**:是否保留 `advanceProsody` 作向后兼容空位 → 见 Open Questions;实施时若移除需同步删 P1 留下的 `advanceProsody` 接线与测试(标记为本变更的回归项)。

### D4:userText 来源 = omni `transcript` 事件;reply = 剥标签后干净回复

- `userText` = omni 首条 `transcript` 事件文本(omni 模型听音频转写的用户话语)。**若 omni 未给 transcript**(空)→ 仍可收尾,但 `userText` 为空时文本评估/立场/记忆按空串处理(appraiser 近零拉力、不写空 user 消息——见 D5)。
- `reply` = `#replyAccum`(P1 已保证是**剥标签后**的干净文本)。半句写回(打断)路径**不变**(仍走 `#interrupt` 的 `appendMessage` 半句),收尾入口只在回合**自然结束**(`#finishTurn` 前)调用。

### D5:避免 user 消息重复落库

omni 路当前在 `transcript` 事件手动 `appendMessage(role:'user')`(`voice-loop.ts:749`)。`finalizeExternalTurn` 也会写 user 消息。二者会**重复**。

- **决定**:**移除** omni 路在 `transcript` 事件里的手动 `appendMessage`,统一由 `finalizeExternalTurn` 写 user+assistant 两条(与 STT/文字路一致:`finalizeTurn` 在回合末尾一次写两条)。
- **代价**:user 消息从「转写即写」推迟到「回合收尾写」——但 omni 回合内不依赖「user 消息已落库」做召回(`composeOmniInstructions` 用空 query 召回历史,不含本轮),故推迟无功能影响,且与 STT 路时序一致(STT 路也是收尾才写)。

### D6:零回归门控

- **路径门控**:`finalizeExternalTurn` 只被 omni 路收尾调用;STT 路走 `send`、文字路走 `send`,均不经过新方法。
- **接线门控**:VoiceLoop 新 `finalizeTurn?` 钩子缺省不注入 → omni 路收尾**降级**为「至少写 user+assistant 消息」的最小收尾,或保持 P1 行为(见 Open Questions);注入后才走全套对齐。装配层仅 omni 路注入(`...(omni ? { finalizeTurn: (u,r,o)=>convo.finalizeExternalTurn(u,r,o) } : {})`)。
- **降级门控**:`finalizeExternalTurn` try/catch 整体兜底;VoiceLoop 侧 `void`+catch,收尾失败不影响已播出的回复、不崩、干净回 listening。

## Risks / Trade-offs

- [omni 无真实 `composeSystem` prompt,trace 的 system/messages 字段语义略偏] → 填 `composeOmniInstructions` system + 合成 messages,trace 仍可重放回合输入/输出;在 trace 里标注来源为 omni 直路(可加 provider/path 标识)。
- [`finalizeExternalTurn` 复算 mood/stance/召回 = 与 `composeOmniInstructions` 当回合开头算的有少量重复] → 收尾在回合末尾、非热路径,重复成本可忽略(确定性同步函数 + 关键词召回);不引入语义嵌入。
- [移除手动 `appendMessage` 后,若 `finalizeExternalTurn` 整体失败 → user 消息也丢] → `finalizeTurn` 内部写两条消息是收尾**最先**几步且各自 try 兜底;整体 catch 仅兜后续步骤。可把「写两条消息」放在 try 外层最前以保底(实施时确认 `finalizeTurn` 内消息写入不被早期步骤抛错跳过)。
- [P1 的 `advanceProsody` 废弃 = 删除已归档 change 落地的接线/测试] → 属本变更**有意的收口**(消除双 prosody 推进);在 tasks 标为回归项,删除时确保 omni prosody 经新路仍有测试覆盖(prosody→PAD 不丢)。
- [双语原生输出(dualOutput)的 displayExtractor 在 omni 路是否生效] → omni 路目前无 dualOutput 装配;`finalizeExternalTurn` 复用 `finalizeTurn` 时若 deps 带 displayExtractor 则自动生效(写显示段),缺省恒等写全文,零额外处理。
- [turn span 生命周期] → `finalizeExternalTurn` 自开自闭 turn span(不嵌套 send 的),与 omni 回合一一对应;correlationId 用 `sessionId/turnId/0` 同款,可追溯不串。

## Migration Plan

纯加法 + 一处收口(废弃 P1 `advanceProsody` 旁路)。无 schema 变更、无数据迁移(写的是既有 message/memory/closeness/trace 表)。回滚 = 装配层不注入 `finalizeTurn` 钩子(运行时回退到最小收尾或 P1 行为);代码层回滚则 revert 本 change 提交(P1 的剥标签/指令仍在,prosody→PAD 退回 P1 旁路)。

## Open Questions

- **`advanceProsody` 钩子是否保留为兼容空位**:倾向移除(语义被 `finalizeExternalTurn` 覆盖),但若担心已有 desktop 装配依赖它,可先并存一个 release 再删。需用户/维护者拍板「直接收口删除」还是「保留一版兼容」。
- **未注入 `finalizeTurn` 钩子时 omni 路的缺省收尾**:是「最小收尾(只写两条消息)」还是「保持 P1 行为(走 `advanceProsody`)」?推荐前者(更简单、行为可预期),但需确认不破坏 P1 归档场景的回归测试。
- **trace 的 system/messages 填法**:填合成值 vs 把 `finalizeTurn` 这两个入参可选化(小重构)。倾向填合成值(改面小);若团队偏好 trace 严格只记真实 prompt,则做可选化重构。
- **`turn` 序号是否与 `send` 共享 `#turnSeq`**:共享可保证 turnId 全局单调(omni 与文字混用时);确认无并发回合(VoiceLoop 半双工,单回合在途)。
