# chat-A「多模态模型语音输入达成情感感知」链路调研(2026-06-25)

> 范围:chat-A **自己的设计与代码**里「直接用多模态模型做语音输入、从而达成情感感知」的链路——
> 设计意图、实现现状、情感感知如何达成、缺口与落地建议。
> 焦点:**omni 多模态路**(`CHAT_A_VOICE_PATH=omni`)对比**现行 STT+情绪标签路**(缺省 `stt`)。
> 体例:看到什么写什么,精确到文件/函数/行号;`【调研】` 表示来自项目设计文档自身标注的调研结论(非真机)。
> 注:同批另有 `docs/voice-io-reference-survey-2026-06-25.md`(参考项目语音 I/O 调查),本文与之独立。

---

## 0. 一句话结论

chat-A 设计里**确实把「多模态模型直接听原始音频」当成情感感知的上策**(绕开 STT 把语气/韵律压扁成文本),
但**当前代码里这条 omni 路并没有把「用户怎么说的(情绪)」结构化地喂进 PAD 情感内核**——
真正把语音情绪喂进 PAD 的,是**另一条 STT 路**(qwen3-asr-flash 的 7 类情绪标签 → `prosodyToPadPull`)。
omni 路的「情感感知」目前**只能隐式体现在模型回复措辞里**,**到 PAD 的显式映射链路是断的**。

---

## 1. 设计意图:为什么要用多模态模型做语音输入达成情感感知

### 1.1 最直接的设计文档:`docs/chat-a-voice-v2-multimodal.md`(文件名即「multimodal」)

该文是「用 Qwen-Omni 多模态模型替代 STT + LLM」的专章,情感动机写得最露骨:

- **§一 管线对比**(行 10–21):v1 传统 `Mic→VAD→STT→LLM→…`,标注「STT后丢失语气信息」;
  v2 多模态 `Mic→VAD→Qwen-Omni→…`,标注「音频直达模型保留语气」。
  并明列**新增的能力**:「模型从原始音频中直接感知情绪/语速/语调」(行 21)。
- **§二 为什么这个组合恰好解决矛盾**(行 28–34):「语气情绪很重要 → 原始音频直接送入模型 / 模型听到的是真实语调,不是 STT 转写后的扁平文本」。
- **§五 情绪感知的双通道**(行 103–133):核心论点——
  > 「情绪感知从『猜测』变成『感知』」。
  举例:用户说「我没事」(声音发颤、语速缓慢),v1 纯文本 LLM 可能误判「真的没事」、丢失颤抖和停顿;
  v2 Qwen-Omni 听到真实语调,能回「你的声音听起来有点低落…」。
  并画出**情绪流向**(行 118–133):`Omni 输出 [user_emotion:sad-7] → 流式分类器解析出 emotion{user:'sad',intensity:7} → 人格引擎更新用户情绪快照/调节共同调节/影响下次系统提示`。

> ⚠️ 关键:v2 设计里的情感感知是靠**让模型在回复尾部输出显式情绪标签** `[user_emotion:sad-7]`,
> 再由「流式分类器」剥出 emotion 字段喂人格引擎。**这是设计意图,但下文 §2/§3 会看到当前代码并未实现这一显式标签链路。**

### 1.2 双路径统一架构:`docs/chat-a-voice-v3-unified.md`

把 Omni 从「替代方案」收敛为「网关里的一个 Provider」,**多模态优先、传统兜底**:

- **§一/§三**(行 9–27、69–110):Omni 作 `supportsAudioInput:true` 的 Provider;路由「有音频+Omni 可用?是→多模态路径,否→传统 STT→LLM」。
- **§五 两个路径的情绪感知能力差异**(行 169–188):明确写取舍——
  - 路径A(多模态):情绪来源=模型从原始音频感知,**准确度高(听到真实语调)**,**延迟较高(音频处理 3–5 秒)**;
  - 路径B(传统):情绪来源=模型只能从文字猜测,准确度中(可能误判),延迟低;
  - 结论:「多模态在情绪感知上有质的优势,值得优先使用。传统路径保证在任何情况下系统都不崩溃。」
- **§六 三级故障切换**(行 190–209):Omni → DeepSeek 文本(先 STT) → Ollama 本地,降级链完整。

> 注:v3 文档里「路径A=多模态、路径B=传统」;但**代码里的命名相反**——`qwen-omni-llm.ts` / VoiceLoop 注释把 omni 直路称作「**path B**」、把 STT 路称作现行路径。下文以**代码口径**为准(omni=path B)。

### 1.3 权威设计:`docs/chat-a-canonical-design.md`(语音/情感章节)

- **§4 语音管线**(行 167):「**双路径**:优先多模态 audio-in Provider;失败/超预算降级到 STT+LLM+情感补丁。」
  → 把 STT 路明确定位成**降级路径 + 「情感补丁」**(即 STT 自身不带端到端情感理解,需补丁补足)。
- **§4 行 170**:流式 3 层过滤把 `LLM delta` 剥出「情绪标签(→人格)」——与 v2 的 `[user_emotion:…]` 显式标签设计呼应。
- **§7#5 从语音读情绪 prosody**(行 507):
  > 「**从语音读情绪 prosody**(`stt`/情感预检测):听出疲惫/低落(怎么说的),不只是说了什么。」
- **§7 用户语音优先级原则**(行 516、519):「带情绪的语音(prosody)永不漏听」「永远感知/捕获用户语音…prosody 不丢」——
  情感感知被抬到「不可配的底线」级别(无论走哪条路,语音情绪都不能丢)。
- **§6.3**(行 478–480):另有一处多模态用于「图片→人物画像」预填人格种子,属设置期能力,与本文语音情感链路无关,仅备注。

### 1.4 设计意图小结

设计上要用多模态模型做语音输入达成情感感知,预期相对 STT+情绪标签的优势(项目文档自述):
1. **端到端理解语气/韵律**:模型直接「听」原始音频,不经 STT 把副语言信息(颤抖、停顿、语速)压扁成扁平文本(v2 §一/§五);
2. **单次调用省模块**:一口吃掉 STT+LLM,模块从 11 减到 9(v2 §八);
3. **情绪从「猜」变「感知」**,准确度有质的提升(v3 §五)。
**写明的风险/取舍**(v2 §九/§十、v3 §五/§六):首 token 延迟高(音频处理 3–5 秒,算 heavy tier)、单 Provider 无 failover、情绪感知可能不准(故人格只作低权重参考)、带宽/成本——
**对策一律是「降级回 STT+LLM」**,双路径本就是设计骨架。

---

## 2. 实现现状(精确到文件/函数/行)

### 2.1 `QwenOmniLlm` / `respondToAudio` 实现到什么程度

文件:`packages/providers/src/qwen-omni-llm.ts`

- **协议**:DashScope WebSocket 实时多模态(OpenAI-Realtime 风格)。**仅音频面**(audio-in → 文本流)。
  类头注释(行 11–13)明说:「这是 omni-realtime 的核心价值(让模型直接『听』原始音频、感知情绪),
  为后续 runtime 接入 audio-in 直路(路径B)留接缝——**本 change 不接 VoiceLoop**,只提供并测试此面。」
- **早稿的「文本兼容面」已被移除**(行 15–18 注释 + `docs/voice-module-issues-2026-06-25.md` §A7):
  官方核实 DashScope realtime 的 `conversation.item.create` 仅接受 `function_call_output`、音频输入必需,故文本路协议不成立,
  从 LLM registry 注销 `qwen-omni`(commit `b15b4af`)。**所以 omni 不在 LLM registry 里**,只能当 audio-in 端口注入。
- **会话编排**(`#run` 行 143–201、`#handleServerEvent` 行 204–256、`#pumpAudio` 行 263–281):
  建连 → `session.created` → `session.update`(`modalities:['text']`,`input_audio_format:'pcm'`,`turn_detection` 按模式)→
  `input_audio_buffer.append`(base64 PCM)→ manual 模式送完 `commit`+`response.create` → 收事件 → `response.done` 关 WS。
  含 AbortSignal 真取消(`onAbort` 行 170–175 关 WS+终止生成器)、错误 fail-fast(供上层降级)、WS 可注入(测试不触网)、惰性连接。

#### ★ `OmniEvent` 到底产出什么字段(本调查核心证据)

`OmniEvent` 类型定义(行 27–34)**只有三种,均无情感/韵律字段**:

```ts
export type OmniEvent =
  | { readonly type: 'transcript'; readonly text: string }  // 用户输入音频的转写
  | { readonly type: 'text'; readonly text: string }        // 模型回复的文本增量
  | { readonly type: 'end' };                               // 本轮结束
```

`#handleServerEvent`(行 214–255)消费的服务端事件:
- `response.text.delta` / `response.audio_transcript.delta` → `{type:'text'}`(行 232–236);
- `conversation.item.input_audio_transcription.completed` → `{type:'transcript'}`(行 238–241);
- `response.done` / `response.completed` → `{type:'end'}`(行 243–247);
- `error` → fail;
- **`default: return`(行 253–254)**:注释「其余事件(session.updated / speech_started 等)本 change 不消费」。

**结论:`QwenOmniLlm` 当前实现完全没有提取任何情感/韵律信号**——不读情绪事件、不解析回复里的 `[user_emotion:…]` 标签,
OmniEvent 里也没有承载情绪的字段。**v2 §五 设计的「显式情绪标签 → 人格引擎」在 omni provider 这一层就没落地。**

### 2.2 omni 路在装配层接到哪了

文件:`packages/client/src/cli-voice.ts`

- `loadVoicePath(env)`(行 74–76):`CHAT_A_VOICE_PATH=omni` → `'omni'`,缺省/空/其它 → `'stt'`。
- `createOmniAudioPort(env)`(行 105–126):
  - key 读 `CHAT_A_DASHSCOPE_API_KEY`,**缺失 → 打印中文提示、返回 undefined(回落 STT,绝不崩)**(行 106–112);
  - model 缺省 `DEFAULT_OMNI_MODEL = 'qwen3-omni-flash-realtime'`(行 66、116);baseURL 缺省 `QWEN_DASHSCOPE_REALTIME_URL`;
  - 直接 `new QwenOmniLlm({...})`(行 114–119)当端口(它**不在 LLM registry**,但 `respondToAudio` 形态满足 `OmniAudioPort`);
  - 构造抛错 → catch、提示、返回 undefined(回落 STT)。
- `startVoiceMode`(行 313–416)装配:
  - `wantOmni = loadVoicePath(env)==='omni'`;`omni = wantOmni ? createOmniAudioPort(env) : undefined`(行 346–347);
  - **`effectivePath = omni !== undefined ? 'omni' : 'stt'`**(行 349)——双保险:端口构造不出即便选 omni 也如实标 stt;
  - 注入 `runVoiceLoop` 的 `loopDeps`(行 372–378):仅当 `omni !== undefined` 才带 `{ omni, voicePath:'omni', composeOmniInstructions? }`。

desktop 侧(`packages/desktop/src/main.ts`):据 `docs/voice-module-issues-2026-06-25.md` §D1/§D3,desktop voiceStart 也复用同一套装配(omni-persona-context、ttsOptions 已补)。

### 2.3 omni 是否被 VoiceLoop 真正使用?

**是,已接进 VoiceLoop**(与 v2 §一文件名注释「本 change 不接 VoiceLoop」相比,**后续 change 已补接**)。

文件:`packages/runtime/src/voice-loop.ts`

- `OmniAudioPort` 接口(行 78–84)、`VoiceOmniEvent`(行 58–61,与 provider 的 `OmniEvent` 结构等价、runtime 侧最小重声明,避免反向依赖)。
- `#beginThinking`(行 577–583):`if (#omni !== undefined && #voicePath === 'omni') → #startThinkingOmni(omni)`,否则 `#startThinking()`(STT 路)。双保险:omni 缺失即便选 omni 也回落 STT。
- `#startThinkingOmni`(行 684–756):endpointing 攒的音频帧**不喂 STT**,转成 `PcmChunk` 流喂 `omni.respondToAudio(toChunks(), opts, ac.signal)`,消费事件:
  - `transcript`(首条)→ `#go('stt:final')` 推进迁移 + **写记忆(role:'user')**(行 713–731);
  - `text` → 累积 `#replyAccum` + `SentenceSplitter` 分句 → `#speak` → TTS(行 732–734);
  - `end` → flush 尾句、等出尽、`#finishTurn`(行 735–744);
  - 复用既有打断/generation/半句写回/降级核心(行 745–754,失败干净回 listening 不崩)。
- `composeOmniInstructions`(行 158、684–775):omni 回合调 `respondToAudio` 前 `await` 组装 persona/记忆/语气的系统提示
  (修 omni 回复退化成「通用 AI 助手」腔的真 bug,见 §D1;commit `621cea5`)。

**真机状态**:`docs/voice-module-issues-2026-06-25.md` 附录速览(行 262):
「✅ 已真网络验证…**qwen omni path-B audio-in 转写**」——即 omni 路的「听懂+转写+回复」已真网络跑通。

### 2.4 ★★ omni 路的情感感知如何流动(对照 §3 看缺口)

把 §2.3 的 `#startThinkingOmni` 与 STT 路 `#startThinking`(行 591–667)逐字对比:

- STT 路 `#startThinking`:`const r = await #transcribe(buf); text = r.text; **emotion = r.emotion**;`(行 599–601),
  之后 `#send(text, onToken, ac.signal, **emotion**)`(行 645)——**第 4 参把情绪透传出去**。
- omni 路 `#startThinkingOmni`:消费 `transcript`/`text`/`end`,**调用链里根本没有 emotion 变量、没有第 4 参**,
  也没有任何 `respondToAudio` 之外的情绪来源。omni 路**完全不向 PAD 透传任何语音情绪**。

**所以:即便 omni 路真音频跑通,它产出的 `VoiceOmniEvent` 里没有情绪字段,VoiceLoop omni 分支也无从把语音情绪喂进 PAD。**

---

## 3. 情感感知到底怎么达成(两路对比,核心)

### 3.1 STT 路(现行活路径):情绪靠 qwen3-asr-flash 的 emotion 标签 → `prosodyToPadPull`

完整闭环(已真网络/确定性验证):

1. **STT provider 产情绪**:`packages/providers/src/qwen-asr-stt.ts`
   - 类头(行 14–23):qwen3-asr-flash 经 OpenAI 兼容端点,响应里 `choices[0].message.annotations[].emotion`(**官方 7 类**)。
   - `VALID_EMOTIONS`(行 67–68)= 7 类枚举;`extractEmotion`(行 202–208)从 annotations 取首条**合法** emotion → `SttEmotion`,无/非法 → undefined(纯加法、不污染)。
   - `SttResult.emotion?`(行 156)纯加法字段。
2. **VoiceLoop 取情绪并透传**:`voice-loop.ts`
   - `#transcribe`(行 798–823)回传被采纳为最终文本那条结果的 `emotion?`(优先 final);
   - `#startThinking` 取 `r.emotion`(行 601)→ `#send(text, onToken, signal, emotion)`(行 645)。
3. **映射进 PAD**:`packages/persona/src/prosody.ts` 的 `prosodyToPadPull`
   - 入参 `SttEmotionLike{ label, confidence? }`(行 18–23)——**结构类型,不依赖 providers 包**(接缝边界);
   - `DEFAULT_PROSODY_PAD_MAP`(行 30–37):6 类(happy/surprised/sad/fearful/angry/disgusted)→ PAD `PadPull`,
     量级保守(unit≈0.4,避免语音盖过文本);**neutral 不入表 → 零拉力**;
   - `prosodyToPadPull`(行 48–64):emotion 缺省/标签不在表/neutral → **零拉力(安全降级)**;confidence∈(0,1] 线性缩放;各维钳制 [-1,1]。
4. **并入情感内核**:据 `docs/voice-module-issues-2026-06-25.md` §D2(commit `8e178b0`):
   `send → TurnContext → strategy → finalizeTurn → persona.advance`,与文本 appraiser 拉力按 `PROSODY_PULL_WEIGHT=0.5` 合并、单次 `stepPad`。

冒烟脚本佐证:`scripts/asr-smoke.ts`(行 142–168)端到端演示「WAV → 真云 qwen-asr → 转写文本+情绪标签(7 类)+检测语种 → `prosodyToPadPull` → PAD 拉力」。

> 即:**STT 路真正把「用户怎么说的(韵律/语气情绪)」结构化感知并喂进了 PAD 情感内核**——靠 qwen-asr 服务端返回的离散情绪标签,而非声学特征自建。

### 3.2 omni 路:多模态模型「听」音频时,情感感知去哪了

- **模型侧**:Qwen-Omni 在「听」音频时**当然能感知语气**——这正是 v2/v3/canonical 选它的理由。
  但这种感知目前**只能隐式体现在它生成的回复措辞里**(模型自己决定回得低落/温柔/活泼)。
- **代码侧**:`OmniEvent`/`VoiceOmniEvent` **没有情绪字段**(§2.1),`#startThinkingOmni` **不向 `#send` 透传任何 emotion**(§2.4)。
  v2 §五 设计的「让模型在回复尾输出 `[user_emotion:sad-7]` → 流式分类器剥出 → 喂人格引擎」这条**显式标签链路在代码里完全不存在**:
  - `QwenOmniLlm` 不在 session.instructions 里强制要求模型输出情绪标签(`createOmniAudioPort` 不注入这类指令;
    `composeOmniInstructions` 注入的是 persona/记忆/语气背景,**不是情绪标签协议**);
  - 即便模型自发输出了 `[user_emotion:…]`,VoiceLoop omni 分支也不解析它(`text` 事件整段进 `#replyAccum`/分句喂 TTS,不剥情绪标签),会被当正文读出来。

### 3.3 ★ 结论:`prosodyToPadPull` 吃的是情绪标签,omni 不产标签 → 映射链路是断的

- `prosodyToPadPull` 的入参是 `SttEmotionLike{ label }`(离散标签)。
- omni 路既不产 `SttEmotion`、`#startThinkingOmni` 也不调用 `prosodyToPadPull`、不向 `#send` 传第 4 参。
- **所以 omni 路 → PAD 的情感映射链路在两处断开**:① provider 不产情绪信号;② VoiceLoop omni 分支不透传情绪。

**两路对比的核心结论**:

| | 现行 STT 路(缺省) | omni 多模态路(path B) |
|---|---|---|
| 情绪来源 | qwen3-asr-flash 服务端返回 7 类离散情绪标签 | 模型隐式听懂语气(无结构化输出) |
| 是否喂进 PAD 情感内核 | **是**(`prosodyToPadPull` → `persona.advance`,权重 0.5) | **否**(链路两处断开) |
| 情绪在哪体现 | PAD 状态(影响心情/共同调节/后续语气) | **仅隐式在 omni 回复措辞里**,不入 PAD,不影响心情持久态 |
| 真机状态 | ✅ smoke:asr 闭环跑通(emotion→PAD 确定性纯函数验证) | ✅ 转写/回复跑通,但情感感知未结构化、未入 PAD |

> **悖论**:设计文档把 omni 路捧为「情绪感知有质的优势」的上策(v3 §五),
> 但**当前真正把语音情绪驱动情感内核的恰恰是被定位成「降级/情感补丁」的 STT 路**;
> omni 路在「让 PAD 感知用户怎么说的」这件事上**反而是断的**。这是设计意图与实现现状最大的落差。

---

## 4. 缺口与风险

### 4.1 omni → PAD 情感映射链路缺口(本调查最核心)
- **provider 不产情绪**:`OmniEvent` 无情绪字段;`#handleServerEvent` 的 `default` 分支吞掉了 `speech_started` 等所有非文本事件(`qwen-omni-llm.ts:253-254`)。设计文档(usability-roadmap §3.4 行 164)称「omni-realtime ASR 同样有 emotion 输出」【调研】,但**代码没去读它**,且该字段真存在性**未真机核实**。
- **VoiceLoop omni 分支不透传**:`#startThinkingOmni` 无 emotion 变量、不调 `prosodyToPadPull`、不向 `#send` 传第 4 参(`voice-loop.ts:684-756`)。
- **显式标签协议缺失**:v2 §五 的 `[user_emotion:…]` 标签链路在 provider/分类器/VoiceLoop 三层都不存在。

### 4.2 omni 真网络/协议待确认
- omni audio-in **转写**已真网络验证(`docs/voice-module-issues-2026-06-25.md` 行 262),但 **emotion 输出未验**(附录行 263「🟡 qwen-asr 情绪入 PAD 真效果」属待确认;omni 的情绪输出更未列入已验)。
- model id 待定:代码缺省 `qwen3-omni-flash-realtime`(`cli-voice.ts:66`);usability-roadmap §3.3 列 `qwen3.5-omni-...realtime`;记忆 `qwen-dashscope-api-params` 另提 `qwen3-omni-flash-realtime`。**以真机为准**(项目反复强调的纪律,见 §A 系列教训)。
- `turnDetection`:`manual`(缺省,适配 VoiceLoop 已切好的有限音频段)/ `server_vad`(连续流);两者触发协议不同(`qwen-omni-llm.ts:55-62,263-281`)。

### 4.3 与 canonical 原则的契合度
- **情感内核/PAD**(§7#5、§7 底线行 519「prosody 不丢」):**omni 路违背此底线**——走 omni 时语音情绪不进 PAD,等于「prosody 丢了」(只剩模型隐式回复,心情持久态不受语音情绪驱动)。
- **优雅降级**(§3.2):双向都做得好——omni 端口构造失败/key 缺失/WS 失败均干净回落 STT(`cli-voice.ts:105-126`、`voice-loop.ts:745-754`),`prosodyToPadPull` 对无/未知情绪零拉力降级。
- **延迟预算**:omni 首 token 延迟高(音频处理 3–5 秒,v2 §九 / v3 标 heavy tier),与 STT 路(可用流式 qwen3-asr-flash-realtime)相比在实时陪伴场景偏重;但情感感知本身不在首字延迟关键路径上(STT 路的 emotion 是旁路喂 PAD,不阻塞)。

---

## 5. 可落地建议(优先级)

> 前提认知:**双路径本就是设计骨架**(canonical §4、v3),不是二选一。STT 路已是把语音情绪喂进 PAD 的活路径且 ROI 最高(roadmap 第 1 件称「当前 ROI 最高的一步」);omni 路的独特价值在「端到端听懂语气并直接生成贴合情绪的回复」。建议**两路共存、各取所长**。

### P0 — 先把已验证的 STT 路情绪闭环坐实(最高 ROI,几乎零新增风险)
- 用 `scripts/asr-smoke.ts` 真网络验 qwen-asr 的 emotion 字段真值(roadmap M1.1),核实 7 类标签真返回(附录行 263 标「待确认」)。
- 升级到流式 `qwen3-asr-flash-realtime`(WS,自带情绪 + 自动语种,roadmap §3.5 行 179),降延迟、情绪一举两得。
- **理由**:这条链路代码已全就位(`qwen-asr-stt.ts` + `prosody.ts` + VoiceLoop 透传 + `persona.advance` 合并),只差真值核实,且无原生依赖、只需填 key。

### P1 — 补 omni → PAD 情感映射(让 omni 路也不丢 prosody,落地 canonical 底线)
两条技术路线,建议**先 A 后(可选)B**:
- **方案 A(推荐,低成本):显式情绪标签协议**——沿用 v2 §五 设计:
  1. omni 的 `composeOmniInstructions` 注入「请在回复尾部附 `[user_emotion:label-intensity]`(label 取 7 类之一)」指令;
  2. VoiceLoop omni 分支(或新增一个 omni 流式分类器)从 `text` 累积里剥出该标签 → 转 `SttEmotionLike` → `prosodyToPadPull` → 经第 4 参喂 `#send`(复用 STT 路已有的 PAD 合并通道,零重造);
  3. 剥标签后**别把标签读进 TTS**(避免被念出来)。
  - 优点:复用现成 `prosodyToPadPull` + `persona.advance` 合并;缺点:依赖模型听话输出标签(可加正则兜底 + 缺失即零拉力降级)。
- **方案 B(更准但需真机核实):读 omni 服务端原生情绪事件**——
  若真机核实 omni-realtime 确有情绪输出事件(usability-roadmap §3.4【调研】所称),则在 `#handleServerEvent` 的 `default` 分支上方新增该事件 → 给 `OmniEvent` 加 `{type:'emotion', label, confidence?}` → VoiceLoop 透传。**先真机抓包确认事件名/字段再动手**(项目纪律:别照搬 SDK/文档,以真机为准)。

### P2 — omni 路真网络冒烟 + 双路径降级真测(roadmap M2.1/M2.2)
- 写 `smoke:omni`(类比 `smoke:asr`/`smoke:qwen`):PCM16/16kHz → omni-realtime WS,验证鉴权/事件/转写/(若做 P1-B)情绪事件;钉死真实 model id。
- 真测「omni 失败 → 降级 STT+LLM+情感补丁」(canonical §4),确认降级后情绪仍走 STT 路进 PAD。

### 是否值得 / 取舍
- **值得做 P1(补 omni→PAD),但不必为它牺牲 STT 路**:omni 路的独特红利是「端到端贴合语气的回复生成」,而把情绪喂进 PAD 这件事 STT 路已干得又稳又便宜。
- **共存策略**:沿用现有「omni 优先、构造/失败回落 STT」装配(`cli-voice.ts`);
  在 omni 路补上 P1 的情绪→PAD 后,**两路在 PAD 这件事上行为对齐**,真正兑现 canonical「prosody 永不漏听」的底线;
  延迟敏感/无 key 场景天然落到 STT 路。

---

## 附:关键文件/行号索引

- 设计意图:`docs/chat-a-voice-v2-multimodal.md`(§一行 10–21 / §五行 103–133 情绪双通道)、`docs/chat-a-voice-v3-unified.md`(§五行 169–188 两路情绪差异)、`docs/chat-a-canonical-design.md`(§4 行 167/170、§7#5 行 507、§7 底线行 516/519)、`docs/usability-roadmap-2026-06-24.md`(§3.3 行 152–159 omni 接入、§3.4 行 161–166 prosody→PAD、§3.5 行 178–182 STT 选型、第 1 件 行 191)。
- omni provider:`packages/providers/src/qwen-omni-llm.ts`(OmniEvent 行 27–34、`#handleServerEvent` 行 204–256 含 default 行 253–254、`#pumpAudio` 行 263–281)。
- 装配:`packages/client/src/cli-voice.ts`(`loadVoicePath` 行 74–76、`createOmniAudioPort` 行 105–126、`startVoiceMode` 行 346–349/372–378)。
- VoiceLoop:`packages/runtime/src/voice-loop.ts`(`OmniAudioPort` 行 78–84、`#beginThinking` 行 577–583、`#startThinking` STT 路情绪透传 行 599–601/645、`#startThinkingOmni` 行 684–756、`#transcribe` 行 798–823)。
- STT 路情感:`packages/providers/src/qwen-asr-stt.ts`(emotion 提取 行 67–68/202–208)、`packages/persona/src/prosody.ts`(`prosodyToPadPull` 行 48–64、映射表 行 30–37)。
- 闭环冒烟:`scripts/asr-smoke.ts`(行 142–168)。
- 踩坑/真机状态:`docs/voice-module-issues-2026-06-25.md`(§A7 omni 文本面移除、§D1 omni 人设、§D2 prosody→PAD 最后一公里、附录行 262–263 真机状态)。
