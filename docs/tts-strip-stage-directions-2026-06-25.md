# 朗读剥离括号舞台提示 —— 调研笔记(2026-06-25)

> 只读调研,未改任何源码。结论以源码/文档为准;拿不准处标「待确认」。

## 0. 问题复述

桌面 app(LLM=qwen-plus)里小雪的文字回复带括号舞台提示/动作神态描写,例如:

```
嗯…恭喜啊。
（轻轻笑了一下，指尖转着笔）
不过…先别急着庆祝
```

朗读(TTS)时把「轻轻笑了一下，指尖转着笔」这种括号内动作也念出来,听感很怪。
诉求:括号内容是「演出提示」,**显示可保留、朗读不该读出**。

---

## 1. 括号根因(人设/prompt 来自哪里)

### 1.1 没有任何一处「明确要求」舞台提示式输出

逐处核对人格/提示词组装,**未发现**任何 prompt 片段要求「带括号动作/神态描写」:

- 人设 identity(`packages/persona/src/seed.ts:8-33`,小雪 `XIAOXUE_SEED`):
  - 第 13 行明确要求「像真人朋友那样说话:口语、简短、自然,可以有口头禅;**不要像写文章**,不要说"作为AI",不要过度解释。」
  - 全文无一字提到动作描写/舞台提示/旁白。
- 风格纪律 contributor(`packages/cognition/src/prompt/contributors.ts:69-96`,`StyleDisciplineContributor`):
  - 硬纪律三条(72-76 行):说话像真人朋友/不要自指AI/别罗列要点别长篇大论。
  - 同样**无**「输出动作描写」的诱导,反而方向相反(要求口语简短)。
- tone fragment(`packages/persona/src/tone.ts:56-72`):只注入「当前情绪/温暖/外显/姿态/关系」的**自然语言语气指令**(如「语气可以轻快、带点雀跃」),不是要求写括号动作。
- 异议/重锚/语种 contributor(`contributors.ts:41-143`):均与括号无关。
- 整段 prompt 组装(`packages/cognition/src/prompt/assembler.ts`):只是把上述 fragment 升序拼接,无额外格式指令。

### 1.2 真正根因:LLM(qwen-plus)的「角色扮演」自发倾向

结论:括号舞台提示**不是被 prompt 显式要求的**,而是 qwen-plus 这类对话模型在「你是一位有性格、有情绪的伴侣」这种**强角色设定**下,**自发**产出的角色扮演 (RP) 文风——中文 RP 语料里「（动作）」「*神态*」是极常见的表达惯例,模型见 identity 里「有自己的性格、心情、喜好」(`seed.ts:12`)+「真实共情、留意情绪语气」(`seed.ts:14`)+ tone 里大量情绪语气指令,容易把「表达情绪」具象成括号动作描写。

→ 即:**人设是诱因(强情感/强人设),但无任何一行直接命令舞台提示**。所以单靠「删 prompt 里某句」无法根治(本来就没有那句);需要在 prompt 里**反向明令禁止** 或 在朗读链路**后处理剥离**。

---

## 2. 朗读链路在哪可处理(显示 vs 合成 解耦点)

项目已有成熟的「显示文本 vs 合成文本」解耦(显示语种≠合成语种走翻译通道),**剥括号天然属于同一类「喂 TTS 前对文本做变换、不动显示」的处理**,落点清晰。

### 2.1 桌面文字朗读链路(主问题路径)

- `packages/desktop/src/main.ts:427` `speakReply(handle, reply, signal)`:回合拿到完整 `reply` 后朗读。
  - 由 `registerIpc` 的 `IPC.send` handler 调用(`main.ts:517-531`):`reply` 先经 `runSendTurn` emit 给渲染层定型气泡(`ipc-contract.ts:230-238`),**再** `void speakReply(...)` 后台朗读 → 显示与朗读是两条独立流,改朗读不影响气泡。
- `speakReply` 内部:`main.ts:444-462` 调 `runSpeakReply`(`ipc-contract.ts:673-700`),传入:
  - `splitSentences: splitReplySentences`(`main.ts:417-420`):整段一次合成,`[text.trim()]`。
  - `synthesize: makeSynthesize(...)`(`main.ts:386-410`):逐句喂 `tts.synthesize`。
  - `translate`(翻译通道):仅当显示语种≠合成语种才调。

→ **关键解耦点**:`runSpeakReply`(`ipc-contract.ts:673-700`)里 `spokenText` 是「真正喂 TTS 的文本」,与 `displayText`(已进气泡)完全分离。它甚至已返回 `spokenText`「解耦后它可能 ≠ displayText」(`ipc-contract.ts:672`)。**在算出 `spokenText` 后、`splitSentences` 之前剥离括号即可**,显示完全不动。

### 2.2 语音模式链路(同样有此问题)

- VoiceLoop `#startThinking`(`packages/runtime/src/voice-loop.ts:624-653`):`onToken` → `SentenceSplitter.push` → `enqueueSpeak` → `#speak`(`voice-loop.ts:834-839`)→ `tts.synthesize`。
- omni 路径(`voice-loop.ts:686-743`)同构:`ev.text` → splitter → `#speak`。
- `SentenceSplitter`(`packages/runtime/src/sentence-splitter.ts`)只按标点切句,**不剥任何标签/括号**。

→ 语音模式下 LLM 文本**直接**喂 TTS,无任何剥离,同样会念出括号。修复需覆盖两条路径。

### 2.3 ⭐ 已存在但未接线的现成方案:`classifyText`

`packages/runtime/src/classifier-processor.ts` 已实现**正是为本问题设计的纯函数** `classifyText(input)`(承 canonical §4.2「流式 3 层过滤:剥工具调用/表情标签/舞台指示 → 分流 显示文本 / 口语文本(→TTS) / 情绪标签(→人格)」,见 `docs/chat-a-canonical-design.md:161`):

- 产出三路:`spokenText`(剥所有标签/括号/工具/emoji → 喂 TTS)、`displayText`(剥工具+emoji+情绪标签,保留「舞台指示」)、`emotionTags`(→人格)。
- 标签正则 `TAG_RE`(`classifier-processor.ts:41`)已覆盖:`[xx]`、全角`（xx）`、半角`(xx)`、`*xx*`、`【xx】`。
- 已导出(`packages/runtime/src/index.ts:11`),有完整 golden 测试(`packages/runtime/test/classifier-processor.test.ts`)。

**但它在生产代码里从未被调用**(grep 确认:仅自身 + 自身测试引用)——即设计早已规划、实现也在,只是**朗读链路/VoiceLoop 都没接上**。这是核心发现:解法基本「现成」,缺的是接线。

⚠️ **重要陷阱**:`classifyText` 当前对用户的**真实例子会误删显示**。它用「舞台指示白名单」`STAGE_DIRECTION_HINTS`(`classifier-processor.ts:55-68`:小声/大声/停顿/沉默/旁白/低声/清嗓/咳嗽/转身/看向/走近…)判断「是否保留进 display」。`isStageDirection` 用 `startsWith`(`:76-79`)。用户例子 `（轻轻笑了一下，指尖转着笔）` **不以任何白名单词开头** → 被判为「情绪标签」→ **从 spoken 和 display 两路都剥掉**(`:116-119` / `:134-137`)。结果:朗读对了,但**气泡里也看不到这句动作描写**,违背诉求「显示保留、朗读剥离」。

→ 若复用 `classifyText`,要么扩大舞台指示白名单 / 改判定为「凡括号包裹的动作短语都算舞台指示(保留 display)」,要么只取它的 `spokenText` 喂 TTS、显示仍用原始 reply(最省心,见 §4)。

---

## 3. 两条解法路线 + 推荐

### (A) 后处理剥离(朗读前正则去括号,只剥朗读、不动显示)
- 优点:确定性、零额外延迟/token、立即生效、对所有模型都管用(不依赖 LLM 听话);天然契合既有「spokenText≠displayText」解耦;**已有 `classifyText` 可复用**。
- 缺点:正则有边界 case(见 §5);可能误删/漏删少数情形。

### (B) 提示词约束(prompt 里禁止/规范括号输出)
- 优点:从源头减少括号产出,减轻 A 的负担。
- 缺点:① qwen-plus 不一定每次都听话(RP 倾向强,长对话里 steer 会被稀释);② **可能牺牲表现力**——用户也许**想要**气泡里有动作描写(更像真人/更有戏),只是不想被读出来。若 prompt 强行禁止,显示也没了。这与诉求「显示保留、朗读剥离」**直接冲突**。

### ⭐ 推荐:以 (A) 为主,(B) 仅作可选弱辅助 / 默认不加

- **主用 A(后处理剥离)**,理由:
  1. 诉求本质是「显示保留、朗读剥离」——这只有 A(对朗读文本做变换)能精确满足;B 一旦生效就连显示一起没了。
  2. A 确定性强、不烧 token、不增延迟、跨模型稳定,符合项目「优雅降级/延迟预算」原则。
  3. 现成 `classifyText` 已实现 90%,接线成本低。
- **B 不建议默认开启**。若真机观察到括号过于泛滥影响观感,可加一条**温和**风格纪律(如「动作/神态描写请尽量少」),但**不要**写「禁止任何括号」——否则砍掉用户可能想要的 RP 表现力。B 的定位只是「减少 A 要处理的量」,A 始终是兜底真相源。
- 组合结论:**A 兜底(必做)+ B 可选弱化(默认不加,留 env 开关)**。

---

## 4. 落点建议(若走后处理剥离)

两个落点,**都改、覆盖文字 + 语音两条路径**:

### 4.1 桌面文字朗读(主):`runSpeakReply` 内
- 位置:`packages/desktop/src/ipc-contract.ts:680-685`,算出 `spokenText` 后、`splitSentences` 前,插一步剥离:
  ```
  const spokenText = plan.needsTranslation ? await translate(...) : displayText;
  // ↓ 新增:剥舞台提示再喂 TTS(显示 reply 不动)
  const cleaned = stripStageDirections(spokenText);
  ... port.splitSentences(cleaned) ...
  ```
- 显示与朗读如何解耦:**显示(气泡)走 `IPC.reply`(`main.ts:526` 的 `runSendTurn`,用原始 `reply`)**;**朗读走 `speakReply`→`runSpeakReply`,只对喂 TTS 的文本剥离**。两者已是独立流,改后者不碰前者——天然满足「显示保留、朗读剥离」。
- 注意翻译通道顺序:翻译产出的 `spokenText` 是译文,译文里一般不再带中文括号动作(LLM 翻译时多半丢弃),但仍建议剥离后再合成以防万一(剥离应在翻译之后)。

### 4.2 语音模式:VoiceLoop `#speak` 入口 或 onToken 凑句后
- 位置:`packages/runtime/src/voice-loop.ts:834` `#speak(sentence,...)` 开头,对 `sentence` 先剥离再喂 `synthesize`;或在 `enqueueSpeak`(`:634`/`:696`)前剥。
- ⚠️ 流式分句的边界:`SentenceSplitter` 按 token 凑句,**括号可能跨句被切开**(如「（轻轻笑了\n一下）」分两次 push)。逐句剥离会漏。建议:要么在 splitter 之前对累积文本剥(但流式拿不到完整段),要么 splitter 之后对每句剥 + 接受「跨句未闭合括号」的少数漏网(见 §5)。语音路可先做「整句级」剥离,跨句残缺标「待确认 / 后续优化」。

### 4.3 复用 / 新建剥离函数
- **首选**:把 `classifyText`(`classifier-processor.ts`)接进来,只取其 `spokenText` 喂 TTS;显示继续用原始 reply(绕开 §2.3 的 display 误删陷阱,最省事)。
  - 但需先修「全角括号若非白名单词开头会被当情绪标签」——对朗读无影响(都剥),只影响它自己的 displayText;既然显示不取它的 display,可直接用。
- 若不想引 runtime 依赖到 desktop:在 `packages/desktop/src/ipc-contract.ts`(纯逻辑、已 headless 可测)新增一个小纯函数 `stripStageDirections(text): string`,规则见 §5,配 golden 测试。两路共用同一真相源最好(可放 runtime 或 protocol 共享处)。

---

## 5. 后处理剥离规则 + 边界 case 清单

### 5.1 建议剥离规则(从 `classifyText` 的 `spokenText` 路径提炼,聚焦「喂 TTS」)

剥除以下包裹片段(整体连同包裹符删除),然后折叠空白:

1. 全角圆括号:`（…）`(正则 `（[^）]*）`)
2. 半角圆括号:`(…)`(正则 `\([^)]*\)`)
3. 方括号:`【…】`、`[…]`
4. 星号动作:`*…*`(单个 `*` 包裹)
5. emoji(情绪符号区段,`EMOJI_RE`,见 `classifier-processor.ts:47-48`)
6. (防御)工具块 `<tool>…</tool>`
7. 剥后用 `collapseSpaces`(`classifier-processor.ts:71-73`):合并多余空格、把残留空白并到相邻标点、trim;并清理因整行只剩括号而留下的**空行**(避免 TTS 念到孤立换行/空句)。

### 5.2 边界 case 清单(逐项给处置建议)

| # | Case | 例子 | 建议处置 |
|---|---|---|---|
| 1 | 全角括号 | `（轻轻笑了一下）` | 剥(主目标) |
| 2 | 半角括号 | `(笑)` | 剥 |
| 3 | 方括号/动作 | `【停顿】` `[叹气]` | 剥 |
| 4 | 星号动作 | `*转着笔*` | 剥 |
| 5 | **数字/正常括注** | `(123)`、`(约 15 秒)`、`第(2)点`、`(注:…)` | ⚠️ **会被误删**。当前 `classifyText` 一律剥。权衡:陪伴对话里小雪几乎不会输出数字括注;**且"括号没念出来"比"念出括号动作"危害小得多**。建议:**接受误删**(简单稳健)。若要保留,可加规则「括号内**纯数字/纯标点/含特定关键词(注/约/即)** 则保留」——但会让规则复杂、易引新 bug,**默认不做,标可选**。 |
| 6 | 英文括号含正常内容 | `(see README)` | 同 #5,陪伴语境罕见,接受误删。 |
| 7 | **未闭合括号** | `（轻轻笑了一下` (缺 `）`) | `[^）]*` 不匹配 → **漏删**,会被念出。建议补一条兜底:**行内出现孤立左括号且到行尾/段尾无右括号** → 从左括号删到行尾(保守,可能多删但听感更干净)。标「需 golden 覆盖」。 |
| 8 | **跨行括号** | `（轻轻笑了一下，\n指尖转着笔）` | 正则需 `s` 标志或字符类含 `\n`(`[^）]` 默认已含换行,JS 里 `.` 才不含)。`（[^）]*）` **能跨行匹配**(字符类不受 `.` 限制),✅ 一般 OK。 |
| 9 | **跨句(流式分句切开)** | splitter 把 `（A）` 切成两句 `（A` 与 `B）` | 逐句剥会漏。语音路已知限制;建议「整句级剥 + 接受少数残缺」或在更上游剥。标「待确认 / 后续优化」。 |
| 10 | 括号内含正常表情如 `(笑)` `(无奈)` | `(笑)` | 剥(正是想剥的) |
| 11 | 嵌套/多重括号 | `（他说：(小声)别）` | `[^）]*` 遇内层 `（` 无碍,但内层半角 `(` 会先被半角规则处理;顺序处理即可,基本能清。标「需 golden」。 |
| 12 | 全行只有括号 → 留空行 | 见问题例子第 2 行 | 剥后须清空行,避免 TTS 念空句/多余停顿(§5.1#7)。 |
| 13 | 半角括号在 URL/英文里 | `http://x.com/(a)` | 陪伴对话罕见;接受。 |

### 5.3 边界结论

- 陪伴语境下,**误删「数字/正常括注」的代价远小于「念出动作描写」**;倾向**简单粗暴全剥**(复用 `classifyText` 的 spokenText),不做数字白名单(默认),把复杂度留给真机观察后再加。
- 必须补的硬 case:**未闭合括号(#7)** 与 **空行清理(#12)** —— 这两个直接影响听感,建议进 golden 测试。
- 跨句(#9)是流式语音路的已知局限,标「后续优化」。

---

## 6. 模型 / SSML 层面有无更优机制

- **qwen-plus / DashScope 文本生成**:无「结构化分离旁白 / 输出格式硬约束」可让模型把动作描写单独成段或打标记的官方机制可依赖(`response_format` 之类仅 JSON mode,与 RP 自然语言输出不契合)。只能靠 prompt steer(=路线 B,不可靠)。**结论:模型侧无更优机制,后处理是更稳的真相源。**(待确认:是否有 enable_search/特定参数可抑制 RP,未见相关文档,倾向「无」。)
- **CosyVoice / qwen-tts「跳过某段不合成」标记**:核对 `packages/providers/src/cosyvoice-tts.ts`,**无**「标记某段不朗读」的能力——TTS 收到什么文本就念什么。确认无此机制。
- **SSML(CosyVoice `enable_ssml`)**:见 `cosyvoice-tts.ts:70-71,173,251,271-276`、`tts-config.ts:203-204,322`(env `CHAT_A_TTS_ENABLE_SSML=1`)。SSML 是**输入即标记语言**(开启后整段文本须写成 SSML),用于控制停顿/读法/韵律,**不是「自动识别括号并跳过」**;且要靠 LLM 主动产出合法 SSML(更不可控),还只 CosyVoice 支持、qwen-tts 无。**SSML 帮不上忙**(反而增复杂度)。

---

## 7. 总结(交付要点)

1. **括号根因**:无任何 prompt 显式要求(`seed.ts:8-33`、`contributors.ts:69-96` 均无);是 qwen-plus 在强人设(`seed.ts:12,14`)下**自发的角色扮演文风**。人设是诱因、非命令。
2. **推荐解法**:**(A) 后处理剥离为主(必做)**,显示走原始 reply、朗读走剥离后文本;(B) prompt 约束**默认不加**(会牺牲显示侧表现力,且不可靠),仅留作可选弱化。
3. **现成资产**:`packages/runtime/src/classifier-processor.ts` 的 `classifyText`(canonical §4.2 设计、已导出+已测,但**生产从未接线**)正是为此而建——**最优路径是接线它的 `spokenText`,显示仍用原文**(绕开它 display 误删 `（轻轻笑了…）` 的陷阱)。
4. **落点**:文字路在 `ipc-contract.ts:680-685`(`runSpeakReply` 算出 spokenText 后剥);语音路在 `voice-loop.ts:834` `#speak`(或 enqueue 前)。两路都要改;两路共用同一剥离真相源最佳。
5. **边界**:括号(全/半角)/方括号/星号/emoji 全剥;**未闭合括号 + 剥后空行**必须处理(进 golden);数字/正常括注**接受误删**(陪伴语境代价低);跨句残缺为流式语音已知局限(后续优化)。
6. **模型/SSML**:qwen-plus 无可靠输出格式约束;qwen-tts/CosyVoice 无「跳过某段」标记;SSML 是输入标记语言、帮不上忙。**后处理是更稳的真相源。**
