# 情感控制 vs 复刻音色保真 —— 调研笔记(2026-06-25)

> 调研代理产物,只读 + 调研,未改源码。来源:阿里云百炼/DashScope 官方文档 + 项目记忆 `cosyvoice-clone-synth-contract` / `qwen-tts-clone-model` + 通用 TTS 知识。
> 命名约定:本文 UTF-8;勿与 `docs/` 旧 GBK 报告混编。

## 0. 问题复述(真机已确认的矛盾)

chat-A 用 **CosyVoice v3.5-flash** 复刻音色("像")。真机实测:
- 纯复刻(无 instruction)最像;
- 加自然语言情绪指令(如"温柔亲切")最不像;
- 加描述声音本身的指令(如"声音低沉")明显漂;
- `CHAT_A_TTS_RATE=0.8`(数值语速)**不伤**音色。

核心结论:CosyVoice 的 **自然语言 `instruction`** 是"风格 + 韵律 + 音色"耦合在一个文本提示里的控制方式——模型按指令重新生成说话风格时会顺带改音色。这是机制层面的耦合,**不是参数没调对**。

---

## 1. 有没有"音色锁定 / 相似度 / timbre strength"类参数?

**答:没有。官方文档全集里不存在 similarity / speaker_strength / timbre / style_degree / voice_strength 这类"音色保真强度"或"情感强度"的数值旋钮。**(已查 CosyVoice WebSocket API、复刻/设计 API、实时合成用户指南、SSML 文档)

能影响"像不像"的只有**复刻创建期(create_voice)**的几个间接项,合成期无法调:

| 参数(create_voice 期) | 作用 | 取值/建议 |
|---|---|---|
| 样本时长 | "时间越长效果越好,较好还原度至少 20s 以上" | 复刻样本尽量 ≥20s(项目记忆已记 10~20s) |
| `max_prompt_audio_length` | 提示音频最大长度 | 3.0–30.0 秒 |
| `enable_preprocess` | 音频预处理(降噪等),有背景噪音时建议开 | 影响复刻质量,不是合成期相似度旋钮 |
| `language_hints` | 帮模型识别样本语种以更准提取音色特征 | 注册期定语种最稳 |

➡️ **结论:没有"开了就锁音色"的开关。"既要情感又要保真"无法靠一个官方参数解决,必须靠"用哪条控制通道"来规避耦合。** 这正是下面方案排序的依据。

---

## 2. 关键发现:**SSML prosody 改 pitch/rate 官方明示"不影响音色本身"**

这是本次调研最重要的正向发现,直接对应那个矛盾:

> 官方 SSML 文档(`introduction-to-cosyvoice-ssml-markup-language`):**"prosody 参数 rate/pitch 的改变不影响音色本身,仅改变表现方式。"**

也就是说,DashScope 把控制拆成了两条**机制不同**的通道:

- **自然语言 `instruction`**(FreeStyle):生成式重新演绎说话风格 → **会连音色一起动**(真机已证)。
- **SSML / 数值 prosody**(rate/pitch/volume + break):**信号/韵律层 DSP 式调节** → 官方明示**不动音色**。

➡️ 这把"情绪表达"从"会伤音色的通道"搬到了"不伤音色的通道",是规避矛盾的**最优落地路径**(详见方案 B/C)。

### SSML 能力清单(CosyVoice,官方)

- 根标签 `<speak>`,可带属性:`rate`(0.5–2.0)、`pitch`(0.5–2.0)、`volume`(0–100)、`bgm`(背景音乐 OSS URL)、`effect`。
- `<prosody>`:局部控制 rate/pitch/volume(**不动音色**)。
- `<break time="...">`:停顿,1–10 秒 或 50–10000 毫秒(可制造"欲言又止 / 停顿思考"的情绪感)。
- `<phoneme>` / `<sub>` / `<say-as>` / `<soundEvent>`(插入外部声音)。
- `<speak effect="...">`:robot / lolita / lowpass / echo / eq / lpfilter / hpfilter(**这些是变声/音效,会改音色,情感场景别用**)。
- 🔴 **CosyVoice SSML 没有 emotion / 情感专用标签**。情感只能靠 prosody(快/高=兴奋,慢/低=低落)+ break(停顿)间接表达,或回到 `instruction`。
- 支持模型:cosyvoice-v3.5-flash / v3.5-plus / v3-flash / v3-plus / v2;**复刻音色支持 SSML**。
- ⚠️ 流式坑:**启用 SSML 时,一个 run-task 只允许发送一次 `continue-task`**(项目朗读已是"整段一次合成",正好兼容;但要注意别再回退到逐句多次 continue)。
- 路径:`parameters.enable_ssml=true`(项目已确认此键),文本写 `<speak>...</speak>`。

---

## 3. 数值参数路线(rate / pitch / volume)能表达多少情感?

CosyVoice run-task `parameters` 数值项(官方 + 项目记忆):

| 参数 | 范围 | 默认 | 对音色 | 对情感 |
|---|---|---|---|---|
| `rate`(语速) | 0.5–2.0(SSML 同) | 1.0 | **不伤**(真机已证 0.8 无害;官方 SSML 也明示不动音色) | 快=急促/兴奋/紧张,慢=低落/温柔/郑重 |
| `pitch`(音高) | 0.5–2.0 | 1.0 | 官方 SSML 明示 prosody pitch **不动音色**;但**幅度过大听感会偏离原嗓**,需真机验安全区间 | 高=活泼/开心/惊讶,低=低落/严肃/疲惫 |
| `volume`(音量) | 0–100 | 50 | 不伤 | 大=激动,小=低语/害羞/疲惫 |
| `<break>` | 1–10s / 50–10000ms(SSML) | — | 不伤 | 停顿=思考/犹豫/哽咽前的留白 |

➡️ **"情绪走数值/SSML、音色靠复刻"是可行的**,能表达**唤醒度(arousal:快慢、高低、强弱)**这一维度,与项目 PAD 情绪模型的 **A 轴(激活度)** 天然对齐。
➡️ **局限**:数值/prosody 难表达"语气里的笑意/哭腔/羞涩"这类**音色性情感**(valence/pleasure 的细腻表达)——那类只有 `instruction` 能做,而 `instruction` 正是会伤音色的。**这是真正的 trade-off 边界**:保真优先就接受"情感粒度=唤醒度为主";要细腻情感就得牺牲一点像或换技术(方案 D)。
➡️ **pitch 的音色副作用待真机验**:官方说"不动音色",但生成式 TTS 大幅移调常有金属感/失真。建议真机扫 pitch ∈ {0.85, 0.9, 1.0, 1.1, 1.15} 听音色是否仍"像"。标 **待真机验**。

---

## 4. v3.5-plus vs v3.5-flash —— instruction 漂移会更小吗?

官方文档(实时合成用户指南 + 复刻/设计 API + 3.5 发布稿):

- 两者**功能对等**:都仅北京地域、都仅支持复刻/设计(**无系统音色**)、都支持任意 `instruction` 控情感/语速、语种/方言集相同、都支持 SSML。
- 3.5 代整体相对 3.x:speaker similarity(说话人相似度)、韵律自然度、音质均有提升;tokenizer 帧率减半、首包延迟降 35%。
- **plus 通常是高保真档、flash 是低延迟/低价档**(阿里命名惯例:plus=质量,flash=速度/成本)。但**官方文档没有明确给出"plus 在 instruction 下音色漂移更小"的量化或定性结论**。标 **待真机验**。
- ➡️ **建议**:既然 plus 主打更高 speaker similarity,**值得真机 A/B**:同一复刻样本、同一 instruction,plus vs flash 听哪个更像。若 plus 明显更稳,则"plus + 温和情绪词"可能直接缓解矛盾(代价:延迟/价格略高,树莓派部署本就走云,影响有限)。
- 模型差异补充:**v3-plus 的复刻/设计音色不支持 instruction**(只有系统音色按固定格式支持);**v3.5-plus/flash 与 v3-flash 的复刻音色才支持任意 instruction**。所以要"复刻 + 情感"必须留在 v3.5-*(或 v3-flash),不能降到 v3-plus。

---

## 5. instruction 措辞:安全情绪词 vs 伤音色词

机制:`instruction` 是自由文本,无情感枚举。**凡描述"嗓音物理属性"的词,等于让模型重塑音色 → 必伤复刻保真;只描述"情绪/语气/语速/韵律"的词,伤害较小**(但仍可能轻微漂,因为是同一生成通道)。真机已证:"温柔亲切""声音低沉"都伤,后者更伤。

### 🟢 相对安全(只调情绪/语气/韵律,不直接点名嗓音物理属性)

> 仍可能轻微漂,但比下面一类小;**唤醒度类(快/慢/停顿/上扬)最安全,可优先**。

- 韵律/语速类(最安全,等价数值参数):`语速稍快` / `语速放慢` / `中间有明显停顿` / `语调上扬` / `语气平稳`
- 情绪类(中等):`开心` / `高兴` / `兴奋` / `悲伤` / `难过` / `生气` / `严肃` / `平静` / `温柔`(注意"温柔"真机偏伤,慎用或弱化)
- 语气修饰:`语气轻快` / `语气认真` / `带着笑意`(`带笑意`可能轻微染色,观察)

### 🔴 危险(直接描述嗓音物理特征 = 重塑音色,**禁用**)

> 这些词本质是"声音设计(voice design)"指令,会把复刻音色覆盖掉。

- 音质/音域:`声音低沉` / `浑厚` / `沙哑` / `磁性` / `清亮` / `尖细` / `厚重` / `空灵`
- 性别/年龄人设:`男低音` / `少女音` / `老人声` / `童声` / `大叔嗓`
- 口音/方言切换:`用河南话` / `粤语腔`(会改发音特征,也偏离原音色)
- 强烈风格演绎:`播音腔` / `戏剧化朗诵` / `夸张` —— 大幅重塑风格,连带改音色

### 实践建议
- 情绪指令**尽量短、单维度**(如只给"语速稍快"或只给"开心"),避免多维度叠加放大漂移。
- **能用数值/SSML 表达的(快慢/高低/停顿/强弱)就别用 instruction**——把唤醒度交给 prosody,把"非用 instruction 不可的"留给少数情绪词。
- 上述词表为社区/实践经验 + 真机两点("温柔亲切""声音低沉"已证伤),**完整安全边界需真机逐词扫验**,标 **待真机验**。

---

## 6. 更高保真技术(若 CosyVoice 两全困难)

### 6.1 本地 GPT-SoVITS(项目已实现 `GptSoVitsTts`)

- 项目已有完整 provider:`packages/providers/src/gpt-sovits-tts.ts`(本地 `POST /tts`,zero-shot 复刻,流式裸 PCM,`voiceCloning=true`,fetch 可注入)。
- **情感 + 保真机制不同**:GPT-SoVITS 走 **参考音频(prompt audio)驱动**——情感由**参考音频的情绪**带出(用一段"开心的参考音"合成就偏开心),而非自然语言指令。这是"**参考编码**"路线,**音色与情感都来自参考样本**,理论上比"指令重塑"更不易丢音色。
- 进阶:GPT-SoVITS 支持 `aux_ref_audio_paths`(多参考音融合)、按情绪准备多份参考音(开心/难过/平静各一段)按 PAD 选用 → **"换参考音切情感、音色始终是同一人"**,正好绕开"指令伤音色"。当前 provider 未暴露 `aux_ref_audio_paths` / 采样参数(design.md 说留作纯加法扩展)。
- 代价:需本地起 GPT-SoVITS 服务(127.0.0.1:9880)+ GPU(`requiresCuda`);**树莓派部署不现实**(项目北极星是嵌入式,GPT-SoVITS 只适合 PC 端);需准备/转写参考音(`prompt_text`/`prompt_lang`)。
- ➡️ 定位:**PC 端"最像 + 情感可控"的强方案**;嵌入式仍需回 CosyVoice。可作为"质量档"与 CosyVoice"轻量档"并存(项目五类后端 Factory 接缝已为此设计)。

### 6.2 qwen 非实时 VC(候选)

- `qwen3-tts-vc-2026-01-22`(HTTP 非 WS,provider 路径不同需新接)。保真**或**更高但不确定;且 qwen 实时 VC 真机已证"不像"(`qwen-tts-clone-model` §6),非实时是否更好**未验**。改善不确定 + 新接成本,优先级低于上面几项。标 **待真机验**。

### 6.3 两段式("先复刻定音色,再加情感且保音色")

- DashScope **没有**"复刻音色 + 独立情感层且保真"的合并模型(qwen 的 instruct 版与 vc 版互斥,见 `qwen-tts-clone-model` §7;CosyVoice 把两者塞进同一 instruction 通道)。
- 真正的"两段式"在云 API 里**不可得**;最接近的是 **CosyVoice 复刻 + SSML prosody**(音色来自复刻、情感来自不伤音色的 prosody 通道)——见方案 B,这已经是云侧"两段解耦"的最佳近似。

---

## 7. 业界通用做法(参考)

"音色保真 + 情感可控"四条路线,与本项目对应:

1. **参考编码(reference/prompt 驱动)**:音色和情感都来自参考音频(GPT-SoVITS、CosyVoice zero-shot)。换情感=换情绪参考音,音色不变。→ **方案 D**。
2. **自然语言指令(prompt 重塑)**:一个文本提示同时管风格+音色(CosyVoice instruction、qwen instruct)。表达力强但**音色耦合**。→ 当前痛点。
3. **风格 token / 情感 embedding**:模型有独立情感向量/标签,与音色解耦(部分商用 TTS、VITS 情感版)。DashScope **未暴露**这类旋钮。
4. **韵律 DSP(prosody/SSML)**:信号层调 pitch/rate/volume/停顿,**不动音色**,但只能表达唤醒度。→ **方案 B/C**,本项目最稳。

➡️ 通用结论与本调研一致:**保真优先的系统普遍把"情感"压到 prosody/参考音两条不伤音色的通道,而不是指令**。

---

## 8. 推荐方案排序

> 评分:保音色(★越多越像)/ 情感表达(★越多越细腻)/ 落地成本(★越多越省)。

### ⭐ 首选 —— 方案 B:复刻音色 + SSML prosody(情感走 pitch/rate/volume/break)
- 保音色:★★★★★(官方明示 prosody 不动音色;真机 rate 0.8 已证无害)
- 情感表达:★★★(唤醒度强:快慢/高低/强弱/停顿;valence 细腻情感弱)
- 落地成本:★★★★(项目已有 `enable_ssml` 路径 + RATE;主要工作=把 PAD→SSML 映射 + 改"组装 `<speak>`"而非发 instruction;注意 SSML 下 continue-task 仅一次,与现"整段一次合成"兼容)
- **风险点(待真机验)**:pitch 大幅移调的音色副作用 → 先扫安全区间;SSML 与复刻音色同用真机确认无异常。

### 方案 C:复刻音色 + 纯数值参数(rate/pitch/volume,不上 SSML)
- 保音色:★★★★★ / 情感:★★(比 B 少 break 等表达) / 成本:★★★★★(改动最小,仅按 PAD 调三个数值,代码已透传)
- 定位:**B 的轻量子集 / 兜底**。若 SSML 真机有坑,先用纯数值参数过渡。

### 方案 A':复刻 + **安全情绪词**(短、单维、只用 🟢 词表,禁 🔴 词)
- 保音色:★★★(比纯复刻差,词选对则可接受) / 情感:★★★★(能表达笑意/哭腔等 prosody 给不了的) / 成本:★★★★★(代码已支持 instruction 透传)
- 定位:**当需要 prosody 表达不了的细腻情感时,有限度地用**;与 B 组合(平时 B,关键句加一个安全情绪词)。

### 方案 E:升 **v3.5-plus** + 温和情绪控制
- 保音色:★★★★(主打高 similarity,**待真机 A/B 证是否更抗漂**) / 情感:同 flash / 成本:★★★(改 model id + 略高延迟/价格)
- 定位:**正交增强**——可叠加在 B/C/A' 之上;先 A/B 测 plus 是否值得。

### 方案 D:本地 GPT-SoVITS + 情绪参考音(PC 端高质量档)
- 保音色:★★★★★(参考驱动) / 情感:★★★★(换情绪参考音,需扩 `aux_ref_audio_paths`) / 成本:★★(需本地服务 + GPU + 准备多份参考音;**树莓派不可用**)
- 定位:**PC 端追求极致"像 + 情感"时**;嵌入式回退 CosyVoice。

### ❌ 不推荐 / 已排除
- 寄望"音色锁定参数"——**不存在**。
- v3-plus 复刻 + instruction——**复刻音色不支持 instruction**。
- SSML `effect`(robot/echo…)做情感——那是**变声音效,会改音色**。
- qwen 实时 VC——真机已证"不像"。

---

## 9. 落地建议(给主控的下一步)

1. **改控制通道**:把当前"PAD/情绪 → instruction 文本"改为"PAD → SSML prosody(rate/pitch/volume/break)",`instruction` 仅在需要细腻 valence 情感时按 🟢 安全词表有限使用。映射示例:
   - arousal 高 → rate↑(≤1.2)/pitch↑(≤1.1)/volume↑;arousal 低 → rate↓(≥0.8)/pitch↓(≥0.9)/加 break。
   - 保持 `CHAT_A_TTS_RATE` 作为基线语速,PAD 在其上微调。
2. **真机扫验清单**(本调研标"待真机验"的点):
   - pitch 安全区间(听音色是否仍"像":0.85/0.9/1.0/1.1/1.15)。
   - SSML(`enable_ssml=true` + `<speak>`)与复刻音色同用是否正常、prosody 是否真不伤音色。
   - v3.5-plus vs flash 同 instruction 的音色 A/B。
   - 🟢 安全情绪词逐词扫(确认每个词对音色的实际漂移量)。
3. **保留 GPT-SoVITS 作 PC 高质量档**(已实现),需要"极致像 + 细腻情感"时启用 + 扩多参考音。

---

## 附:本调研对既有记忆的增量(避免重复 `cosyvoice-clone-synth-contract`)

记忆已记:instruction 支持/字段路径/≤100 字符/情感词组合/rate 会让音色漂(0.8 压住)。**本笔记新增**:
1. **官方明示 SSML prosody(rate/pitch)不动音色** —— 这是把情感从"伤音色的 instruction 通道"搬到"不伤音色的 prosody 通道"的依据(记忆里只说了 rate 实测无害,没有"官方保证不动音色"这一条,且没覆盖 SSML 路线)。
2. **不存在音色锁定/相似度/情感强度参数**(明确排除)。
3. **SSML 完整能力清单 + 没有 emotion 标签 + effect 是变声会伤音色 + SSML 下 continue-task 仅一次**。
4. **🟢 安全词 / 🔴 伤音色词清单**(机制:描述嗓音物理属性=重塑音色)。
5. **v3.5-plus 定位为高 similarity 档,值得 A/B**(记忆未对比 plus/flash 在漂移上的差异)。
6. **GPT-SoVITS 是"参考音驱动"=换情绪参考音切情感、音色不变**,与"指令重塑"机制对比清楚。

## 来源
- [CosyVoice 声音复刻/设计 API(help.aliyun.com)](https://help.aliyun.com/zh/model-studio/cosyvoice-clone-design-api)
- [语音合成 CosyVoice WebSocket API(help.aliyun.com)](https://help.aliyun.com/zh/model-studio/cosyvoice-websocket-api)
- [实时语音合成用户指南(help.aliyun.com)](https://help.aliyun.com/zh/model-studio/realtime-tts-user-guide)
- [CosyVoice SSML 标记语言介绍(help.aliyun.com)](https://help.aliyun.com/zh/model-studio/introduction-to-cosyvoice-ssml-markup-language)
- [阿里 CosyVoice 3.5 发布稿(腾讯新闻)](https://view.inews.qq.com/a/20260303A067Y600)
- 项目记忆:`cosyvoice-clone-synth-contract` / `qwen-tts-clone-model` / `qwen-dashscope-api-params`
- 项目源码:`packages/providers/src/gpt-sovits-tts.ts`、`openspec/changes/archive/2026-06-24-gpt-sovits-engine/design.md`
