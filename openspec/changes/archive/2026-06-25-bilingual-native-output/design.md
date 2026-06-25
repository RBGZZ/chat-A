## Context

desktop "显示≠合成语种"时走翻译通道(`ipc-contract.ts`):`resolveSpokenPlan(displayLang, ttsLang)` 判 `needsTranslation` → `translateForSpeech(port, displayText, targetLang)`(**第二次 LLM 调用**,`complete(system,user)`)→ spokenText → `runSpeakReply` 分句合成。失败回落 displayText。"显示/合成解耦(displayText≠spokenText)是一等概念"(`ipc-contract.ts:500`)。

缺口:spokenText 是**翻译**(生硬/漂意/丢语气)+ 多一次往返(首音慢)。本变更让主 LLM **一次产出两版原生文本**,替代翻译这趟,翻译通道留作 fallback。涉及 §4.1(语种解耦)、§3.2(流式优先)、§3.1(降级/行为即配置)。

## ⚠️ 实施转向(2026-06-25 apply)—— 活路径改为 audio-first,哨兵方案休眠

下文 D1–D7 的「主 LLM 一次产『显示正文 ⟦哨兵⟧ 合成语种口语版』,desktop 按哨兵流式拆分」是**原设计**。apply 阶段真机实测发现:**qwen-plus 不稳定遵从该双段+哨兵格式**(经常只出一段、漏哨兵、或把两版混在一起),拆分路实际不可靠 → 不能作为活路径。

**实际落地的活路径 = 音频优先(audio-first)**,更直接地达成同一目标(原生口语 + 省翻译往返):

- **回复本身就用合成语种**:`assembleApp` 在 `CHAT_A_TTS_DUAL_OUTPUT=on` + 显示≠合成语种(`audioFirst`)时,把 `outputLang` 设为**合成语种**——主 LLM 直接产出地道合成语种回复(本就是原生口语,无翻译生硬)。
- **音频路彻底免翻译**:desktop 把该回复逐 token **直接**流式喂 TTS(`makeTokenStreamReadout`),首句即出首音、**无第二次翻译调用**——比原哨兵方案更彻底地省掉往返。
- **显示语种文字次要、不阻塞音频**:回合后把合成语种回复翻成显示语种(`makeTranslate`),作 `send` 返回值 → `runSendTurn` 定型**覆盖**气泡;翻译失败 → 保留合成语种原文(有字尽力)。气泡在音频之后补显示,符合「文字次要」用户定夺。
- **降级**:音频流式失败 → 整段 `speakReply` 兜底(§3.2);翻译失败 → 气泡留合成语种原文。

**哨兵方案的去向**:`DualOutputContributor` / `DUAL_OUTPUT_SENTINEL` / `extractDisplaySegment` / `DualOutputSplitter` / `makeDualOutputReadout` / `composeSystem`+`Conversation` 的 `dualOutput`/`displayExtractor` 形参——**已完整实现 + 单测覆盖,但默认门控关闭、无调用方接线**(无人填 `dualOutput`、无人调 `makeDualOutputReadout`)→ 恒零注入、对现状零影响,**保留为休眠的未来扩展点**:当出现能稳定遵从「双段+哨兵」格式的更强模型时,可直接启用拿到「音频+显示近乎并行流式」的更低延迟(audio-first 的代价是显示要等回合后翻译)。两个原 🔴 接线缺口在 audio-first 下天然不存在(回复即合成语种、记忆写的就是合成语种回复全文、无哨兵污染)。

## Goals / Non-Goals

**Goals:**
- 一次 LLM 调用得显示语种正文 + 合成语种**原生**口语版(非翻译);省翻译往返、音频更自然。
- **全程流式(硬要求)**:显示正文逐 token 流式进 UI;**口语版逐句流式喂 TTS、音频边生成边出声**(首音不等整段回复、不等翻译)。解决 R7 音频滞后。
- 门控默认 off、同语种不触发、解析失败回落翻译通道——**零回归 + 鲁棒**。
- 口语版纯口语(与括号舞台提示治理在 spoken 上汇合)。

**Non-Goals:**
- 不删翻译通道(留 fallback)。
- 不用强结构化 JSON(破坏流式);用轻量分隔标记。
- 语音模式(voice-loop/omni)双语原生 = 后续(本次只 desktop 文字朗读路)。
- 不改记忆/人格/帧管线核心。**(注:本次需扩 CosyVoiceTts 加流式喂文本 API,见 D7——这是 provider 加法、非核心重构。)**

## Decisions

### D1:轻量分隔标记 + 单次调用,不用 JSON
LLM 输出"显示语种正文\n⟦SPOKEN:<lang>⟧\n合成语种口语版"。分隔用固定哨兵串(不易撞正文)。
- **为何不用 JSON**:JSON 流式需等闭合/转义、破坏逐 token 显示;哨兵串可在流中即时识别并截流(复用 canonical:148 流式检测同类技术)。
- **为何单次调用**:省第二趟 LLM 往返(首音更快),两版同源同人设。

### D2:门控 + 仅双语态生效,默认 off 零回归
`CHAT_A_TTS_DUAL_OUTPUT`(默认 off);仅当 off→不动 + 显示≠合成语种(复用 `resolveSpokenPlan.needsTranslation` 的判定)时才进双语路。否则现状(直接合成 / 翻译通道)逐字不变。

### D3:prompt 门控贡献者(prompt-assembly)
新 dual-output contributor,仅双语态注入"两版 + 哨兵 + 合成语种原生口语 + 纯口语"指令;否则返 null(零注入,镜像 OutputLanguageContributor 的 null 模式)。同步纯函数。
- 注:它与既有 `OutputLanguageContributor`(驱动显示语种)协作——正文仍按显示语种,口语段额外要合成语种。

### D4:desktop 流式拆分(接线点 = send 的 onToken + speakReply)
回合流式时维护一个"是否已过哨兵"状态:哨兵前的 token 照常 `emit(chat:token)`;命中哨兵后,后续 token **不推显示**、累积为 spokenText。回合结束:displayText=哨兵前(进气泡/记忆,原样),spokenText=哨兵后(喂 TTS,替代 translateForSpeech)。
- 哨兵可能跨 token 切分 → 用小缓冲做边界匹配(防哨兵被拆两半漏判)。
- ⚠️ 真实接线点需落在 desktop 文字回合的 onToken 编排(`main.ts` 的 send 处理 + speakReply),**非**核心 Conversation(避免影响 cli/其它前端);Conversation 仍流原始全文,desktop 侧做显示截流与 spoken 提取。**(待 apply 时按真实 send/onToken 代码定准,勿臆断函数签名——参照 emotion-aware-voice 审查教训)**

### D5:解析失败优雅降级回翻译通道
双语态但:无哨兵 / 哨兵后空 / 提取失败 → 回落现有 `translateForSpeech`(再不行 displayText 直接合成)。显示正文此时已照常呈现(哨兵没出现=整段都当正文流了),朗读不中断。**translateForSpeech 保留不删**。

### D6:口语版纯口语,与括号治理汇合
dual-output 指令要求口语版本就不带括号舞台提示 → spoken 直接干净;与"括号舞台提示"治理(prompt 风格纪律 / 朗读剥离)互补,spoken 路不必再剥。

### D7:全程流式音频 —— CosyVoice 单 task 增量喂文本(解 R7,且不引入逐句音色漂移)
**支点**:CosyVoice run-task 协议允许**一个 task 内多次 `continue-task` 增量送文本**(同 task_id、同 voice 上下文)→ 音频边喂边出。故口语版**逐句流式喂进同一个合成 task**:首句到齐即出首音、不等整段;全程单 voice 上下文 → **无逐句音色漂移**(正好绕开当初改"整段一次合成"的原因 [[qwen-tts-clone-model]] §5)。
- **需扩 CosyVoiceTts**:现 `synthesize(text)` 一次性送全文;新增**流式喂文本接口**(开 task → `pushText(chunk)`×N → `finish()` → 产 PcmChunk 流)。这是 provider 加法(可注入 wsFactory 单测),非核心重构。
- **拆分器复用**:口语版 token 流经 SentenceSplitter 切句 → 每句 pushText;末尾 finish。
- **排序张力(关键设计点)**:单次回复里"显示正文 ⟦哨兵⟧ 口语版"是**先显示后口语**,则口语(→音频)要等显示正文流完才开始 → 音频仍滞后显示一截(但**省掉翻译那趟**,且口语一开始流就立即出声,比现状快)。两种取舍:
  - **(默认)先显示后口语**:显示即时流式;音频在显示流完后**立即逐句流式**(不再等翻译、不等整段合成)。实现简单、显示 UX 最佳;音频比显示晚一截但远快于现状。
  - **(可选/后续)逐句交替** `[显示句][⟦S⟧][口语句][⟦D⟧]…`:显示与音频近乎并行流式,延迟最低;但格式更复杂、模型遵从更难。**本次取默认,交替留 Open Question。**
- ⚠️ 与 §3.2 流式优先一致;与现有"整段一次合成"是**双语态专属新路**,缺省/单语种仍走老路(零回归)。

## Risks / Trade-offs

- **模型不守格式(漏哨兵/格式乱)** → D5 降级回翻译通道兜底;哨兵选稳定串 + 提取宽容(容空白/大小写)。
- **哨兵跨 token 被拆** → onToken 小缓冲边界匹配(进 golden:哨兵被任意位置切分仍识别)。
- **显示截流误判**(正文里恰好出现哨兵) → 哨兵用不易撞的串(如含不可见/罕见组合);极端误判仅影响该回合,降级可兜。
- **单次输出变长** → 总 token 与"生成+翻译"相当;但省一次 prompt 开销 + 往返延迟,净首音更快。
- **接线点风险** → 见 D4:apply 时以真实 `main.ts` send/onToken/speakReply 代码为准核定,先读后写。

## Migration Plan

- 纯增量 + 默认 off:不设 `CHAT_A_TTS_DUAL_OUTPUT` → 翻译通道/直接合成逐字现状。无 schema/数据迁移。
- 回滚 = 关开关或 revert;translateForSpeech 始终在,fallback 永远可用。

## 审查发现(2026-06-25 fresh-eyes,待吸收;本 change 已暂缓 pending 音色调研)

🔴 两处真实接线缺口,使本 change **不是 desktop-only、必碰核心**:
- **🔴-1 ttsLang/双语开关无通路进核心**:`PromptContext`(cognition/prompt/types.ts:62-86)只有 `outputLang`,无 ttsLang/dualOutput;`composeSystem`(runtime/turn-shared.ts:30-64)入参只到 outputLang;`TurnDeps.outputLang`(conversation.ts:125)构造期来自 displayLang;**ttsLang 纯 desktop 概念**(只在 resolveSpokenPlan/speakReply),核心不知道。且 contributor 列表**硬编码**在 Conversation 构造(conversation.ts:289-297),无 addContributor 注入接缝。⇒ 需在 PromptContext+composeSystem+Conversation 构造入参加"spokenLang+双语态"字段,assembleApp 据 CHAT_A_TTS_LANG/CHAT_A_TTS_DUAL_OUTPUT 算入(含 applyLang/reset 重建路径 app.ts:280-293)。
- **🔴-2 记忆被全文污染**:`convo.send` 返回的 reply 是全量 acc(conversation.ts:209-217);**记忆写入在 send 内部、写全文**(finalizeTurn→appendMessage + extractor,turn-shared.ts:113/174-181),desktop 截流够不着 → 哨兵+口语版进历史/召回污染。且 `IPC.reply` 定型(ipc-contract.ts:233)用全文**覆盖**流式截流。⇒ 必须碰核心:让记忆只写显示段(finalizeTurn/strategy 用显示段,或 send 返回 `{displayText, spokenText}`);IPC.reply 也要发显示段。
- 🟡 onToken 显示截流落点本身成立(main.ts:521→runSendTurn 注入 onToken,逐 token);哨兵不与 SentenceSplitter 冲突(不在同流)。runSpeakReply 内部自调 resolveSpokenPlan,取代翻译需传入备好 spokenText 走 needsTranslation=false 旁路。

**↳ 更省的替代路(审查反向暴露,记此备选)**:不做单次双语,只把 `translateForSpeech` 的提示词从"翻译"改成"用<合成语种>原生重说一遍、保人设"——仍是第二次调用,但**音频原生不生硬**,且**零核心改动/零记忆污染/显示流式不变**。代价仅多一次调用延迟(与"全程流式/低延迟"原则相悖,故仅作 fallback 备选,非主路)。

**状态更新(2026-06-25)**:音色调研已完成(结论见 [[cosyvoice-clone-synth-contract]]),本 change **复活**并新增硬要求 **全程流式(含音频,见 D7)**;两个 🔴(ttsLang 进核心 PromptContext、记忆只写显示段)**仍待吸收**,apply 前必须先解。⚠️ **去重**:`CosyVoiceTts 同会话流式喂文本`这条 tts-engine 需求已由独立 change `streaming-tts-readout` 落地;本 change 复活时**删掉自己 specs/tts-engine/ 那份 ADDED(或改 MODIFIED),复用 streaming-tts-readout 已落主 spec 的流式 API**,别重复 ADD。另派子代理调研参考项目成熟流式语音方案以确立"流式优先/快反应/音频低延迟"设计原则,结论或反哺本设计(排序张力 D7、首音延迟预算)。

## Open Questions

1. ~~哨兵串的最终形态~~ → **已定** `⟦SPOKEN⟧`(罕见数学括号,抗误撞、不与 stripStageDirections 剥离的括号冲突);进 golden。**但哨兵方案已休眠**(见「实施转向」),活路径不依赖哨兵。
2. ~~desktop send/onToken 真实编排形状~~ → **已核定**:audio-first 在 `main.ts` send 内用 `makeTokenStreamReadout` tee 进 onToken,定型经 `runSendTurn`。
3. 语音模式(voice-loop)双语原生何时接——独立后续(audio-first 思路同样适用:omni 直接用合成语种)。
4. **(新)audio-first 的显示延迟**:显示气泡要等回合后翻译才覆盖,文字比音频晚一截。当前接受(文字次要);若要文字也近实时,需启用休眠的哨兵方案(依赖能遵从格式的模型)或在回合内并行翻译。
5. **(新)休眠哨兵方案的退役 vs 保留**:若长期无模型能稳定遵从格式,可考虑后续删除哨兵机制以减维护面;当前保留(已测、门控关闭、零影响)。
