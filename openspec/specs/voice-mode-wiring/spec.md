# voice-mode-wiring Specification

## Purpose
TBD - created by archiving change voice-real-port-wiring. Update Purpose after archive.
## Requirements
### Requirement: 按 env 选择真/桩 VAD·EOU 实现

`cli --voice` 装配层 SHALL 按环境变量 `CHAT_A_VAD` 选择端点检测(VAD + EOU/TurnDetector)实现:值为 `silero`(或 `real` / `sherpa`)时走**真**路径(注入真 `SileroVadDetector` + `SmartTurnEouModel`);缺省、空、或其它值(含 `stub`)走**桩**路径(`StubVadDetector` + `TurnDetector(StubEouModel)`)。缺省(不设该 env)MUST 走桩,且语音装配与现有行为逐字不变(CI/冒烟默认)。VAD 与 EOU MUST 由同一开关一起切换(端点检测三层为一套)。

#### Scenario: 缺省走桩

- **WHEN** 未设置 `CHAT_A_VAD` 启动语音模式
- **THEN** 注入 `StubVadDetector` + `TurnDetector(StubEouModel)`,`info` 的 VAD/EOU 标识为桩,装配与现状一致

#### Scenario: 显式选真

- **WHEN** 设 `CHAT_A_VAD=silero` 且真 sherpa 模块可加载并满足端口形状
- **THEN** 注入真 `SileroVadDetector` + `SmartTurnEouModel`(由动态加载的 sherpa session 构造),`info` 的 VAD/EOU 标识为真

### Requirement: 动态加载真 sherpa 推理端口且不写入依赖

系统 SHALL 提供真推理 session 工厂(`createSherpaVadSession` / `createSherpaEouSession`),经**动态 import** 按模块名加载 sherpa-onnx(模块名经构造参数或 env `CHAT_A_SHERPA_MODULE` 可覆盖,缺省 `sherpa-onnx-node`),用**鸭子类型**把其同步推理面包成 `VadInferenceSession` / `EouInferenceSession`(`infer(samples: Float32Array): number` + `reset()`)。工厂返回类型 MUST NOT 暴露任何 sherpa-onnx / onnxruntime 原生类型(最小面)。sherpa-onnx MUST NOT 出现在任何 `package.json` 的 dependencies(沿用 `node-audio-device.ts` 隔离纪律,仅动态 import)。

#### Scenario: 动态加载并包成端口

- **WHEN** 工厂用一个导出了「吃 `Float32Array` 同步返回 `number`」推理面的模块构造
- **THEN** 返回实现 `VadInferenceSession` / `EouInferenceSession` 的对象,`infer` 转调底层得概率,`reset` 可安全调用

#### Scenario: 模块装不上抛明确中文错误

- **WHEN** 动态 import 指定模块失败(未安装)
- **THEN** 抛出明确中文错误,提示如何安装(`pnpm add`)及需本机 C++ 构建工具链

#### Scenario: 导出形状不符抛明确中文错误

- **WHEN** 模块已加载但鸭子类型挑不到可用的同步推理面
- **THEN** 抛出明确中文错误,指明需在该工厂模块处补薄适配桥接(而非静默错配)

### Requirement: 真路径加载/构造失败回落桩绝不崩

当真路径(`CHAT_A_VAD=silero`)的动态加载或适配器构造**任一步抛错**时,装配层 MUST 打印明确中文提示并**回落到桩**实现,绝不让语音模式崩溃(承 §3.2 优雅降级,沿用真音频设备装不上回落 Fake 的范式)。回落后 `info` 的 VAD/EOU 标识 MUST 反映实际生效的桩。

#### Scenario: 真模块缺失回落桩

- **WHEN** 设 `CHAT_A_VAD=silero` 但 sherpa 模块加载失败
- **THEN** 打印明确中文提示,回落注入桩,`startVoiceMode` 正常返回句柄不抛,`info` 标识为桩

#### Scenario: 适配器构造失败回落桩

- **WHEN** 真 session 已得但构造真适配器时抛错
- **THEN** 打印明确中文提示,回落注入桩,语音装配不崩

### Requirement: 状态行暴露实际 VAD·EOU 实现标识

`VoiceModeHandle.info` MUST 暴露当前实际生效的 VAD 与 EOU 实现标识(真/桩),`cli` 状态行 SHALL 一并打印,便于手测确认。标识 MUST 反映**回落后**的实际实现(真路径回落桩时显示桩)。

#### Scenario: info 含 VAD/EOU 标识

- **WHEN** 启动语音模式(任一路径)
- **THEN** `info` 含 `vad`、`eou` 字段,其值与实际注入的实现(经回落后)一致

### Requirement: VoiceLoop 可选 omni audio-in 直路(path B)

`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**的 omni audio-in 端口字段(`omni?`),
其形态为 `respondToAudio(audio: AsyncIterable<PcmChunk>, opts?, signal?): AsyncIterable<VoiceOmniEvent>`,
`VoiceOmniEvent` 为判别联合 `{type:'transcript',text} | {type:'text',text} | {type:'end'}`。
该字段为**纯加法**:未注入(`omni===undefined`)时,`VoiceLoop` 的行为与产出 MUST 与本切片
之前**逐字一致**(全程走现有 VAD→EOU→STT→`send`→分句→TTS 路径)。

当注入了 omni 端口**且**当前语音路径选择为 omni 时,endpointing 判「说完」后,`VoiceLoop`
MUST 把累积音频帧喂 `omni.respondToAudio(...)`(而非 STT),并消费其事件:
- `transcript`:作为本轮用户话语(等价 STT 文本),MUST 经 `appendMessage` 以 `role:'user'`
  写入记忆(供记忆/召回),并 MUST 经 `stt:final` 事件携该转写文本推进 endpointing→thinking。
- `text`:作为回复增量,MUST 喂入既有 `SentenceSplitter` 分句并经既有 `#speak` → TTS 下行
  (复用既有分句/TTS/generation 自检路径,首句触发 thinking→speaking)。
- `end`(或流自然结束):MUST flush 尾句、等所有句出尽后经既有 `#finishTurn` 收尾回 listening。

omni 直路 MUST NOT 新增 `VoiceState` 或 `VoiceBusEvent`——复用现有
`endpointing --stt:final--> thinking --tts:first_audio--> speaking --turn:end--> listening` 迁移
(转写来源不同,迁移语义相同)。

#### Scenario: 未注入 omni 端口走现有 STT 路径(逐字不变)

- **WHEN** 不注入 `omni`(或语音路径为缺省 `stt`)驱动一个完整语音回合
- **THEN** 走 VAD→EOU→STT→`send`→分句→TTS,状态序列、BusEvent、下行 tts:chunk 与现状逐字一致

#### Scenario: omni 直路产出 transcript 写记忆 + text→TTS

- **WHEN** 注入吐 `transcript`/`text`/`end` 的 omni 端口、语音路径为 omni,驱动一个回合
- **THEN** `transcript` 文本经 `appendMessage`(role:'user')写记忆并 emit `stt:final`;
  `text` 增量分句下行为 tts:chunk;`end` 后回 listening

### Requirement: omni 直路复用既有打断与真取消

omni 直路回合 MUST 与 STT 路径共用同一打断核心:`VoiceLoop` 为每个 omni 回合建一个
`AbortController` 并把其 `signal` 透传给 `omni.respondToAudio(audio, opts?, signal)`。
barge-in 打断(`#interrupt`)或 `stop()` 时,MUST 调用该 `AbortController.abort()`,使
传入 `respondToAudio` 的 signal 变为 aborted(底层 WS 流真停);`#gen++` 作废、半句写回
(`#replyAccum + [被用户打断]`)、`clearBuffer`、回 listening 的逻辑 MUST 与 STT 路径**完全
一致**(被打断回合的 `respondToAudio` 以 AbortError 终止时,MUST 不重复 reset 状态)。

#### Scenario: omni 回合 barge-in 真取消 + 半句写回

- **WHEN** omni 直路处于 speaking(已累积半句回复)、用户插嘴触发 barge-in
- **THEN** 本回合 `AbortController.abort()` 被调用、传给 `respondToAudio` 的 signal 变 aborted、
  半句带 `[被用户打断]` 写回记忆、状态回 listening、旧 gen 帧不再下行

### Requirement: omni 不可用时优雅降级(§3.2)

omni audio-in 直路 MUST 优雅降级,绝不使系统崩溃,且 MUST NOT 影响默认 STT 路径:
- omni 端口未注入 / 语音路径非 omni → 走 STT 路径(零行为变化)。
- 装配期 omni 构造失败 / API key 缺失 → 装配层 MUST 打印明确中文提示并**不注入 omni**
  (`omni=undefined`),使运行时全程走 STT 路径。
- 运行时 `respondToAudio` 抛错 / 连接失败 / WS 意外关闭(本回合尚未被打断)→ `VoiceLoop`
  MUST 干净结束本回合回 listening(不崩),并记日志。

#### Scenario: omni respondToAudio 抛错降级回 listening

- **WHEN** 注入的 omni 端口的 `respondToAudio` 抛错(模拟连接/鉴权失败)、语音路径为 omni
- **THEN** `VoiceLoop` 捕获错误、干净回到 listening、不崩,后续回合仍可继续

#### Scenario: omni 端口缺失时即便配置为 omni 也走 STT

- **WHEN** 语音路径配置为 omni 但 `omni` 端口为 undefined(装配回落)
- **THEN** `VoiceLoop` 走现有 STT→LLM 路径完成回合,行为与默认一致

### Requirement: 按 CHAT_A_VOICE_PATH 选择 STT/omni 语音路径

`cli --voice` 装配层 SHALL 按环境变量 `CHAT_A_VOICE_PATH` 选择语音路径:值为 `omni` 时尝试
构造 omni audio-in 端口并注入 VoiceLoop;缺省、空、或其它值(含 `stt`)走 STT→LLM 路径。
缺省(不设该 env)MUST 走 STT 且装配与现有行为**逐字不变**。omni 档 MUST 经一个小工厂
(`createOmniAudioPort`)直接构造 `QwenOmniLlm`(它不在 LLM registry),API key 读
`CHAT_A_DASHSCOPE_API_KEY`,model/baseURL 经配置(`CHAT_A_OMNI_MODEL` /
`CHAT_A_OMNI_BASE_URL`)可覆盖、有合理默认;key 缺失或构造失败 MUST 打印明确中文提示并
回落 STT 路径(不注入 omni,绝不崩)。

#### Scenario: 缺省走 STT

- **WHEN** 未设置 `CHAT_A_VOICE_PATH` 启动语音模式
- **THEN** 走 STT→LLM 路径,不构造 omni 端口,装配与现状一致

#### Scenario: 显式选 omni 且 key 就绪

- **WHEN** 设 `CHAT_A_VOICE_PATH=omni` 且 `CHAT_A_DASHSCOPE_API_KEY` 就绪
- **THEN** 经 `createOmniAudioPort` 构造 `QwenOmniLlm` 并注入 `loopDeps.omni`,VoiceLoop 走 omni 直路

#### Scenario: 选 omni 但 key 缺失回落 STT

- **WHEN** 设 `CHAT_A_VOICE_PATH=omni` 但 `CHAT_A_DASHSCOPE_API_KEY` 缺失
- **THEN** 装配层打印明确中文提示、不注入 omni 端口,运行时走 STT 路径,绝不崩

### Requirement: omni 直路携带组装好的系统提示(persona/记忆/语气)

`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**注入
`composeOmniInstructions?: () => string | Promise<string>`,用于为 omni audio-in 直路(path B)
提供组装好的系统提示(persona 身份 + 记忆 + 语气/立场/风格)。当注入了该接缝**且**走 omni 直路时,
`VoiceLoop` MUST 在调用 `omni.respondToAudio(...)` **之前** `await` 该回调取得 instructions,并以
`{ instructions }`(`OmniAudioOpts`)传入 `respondToAudio` 的 opts 参数;`OmniAudioPort` 的 opts 类型
MUST 放宽以容纳可选 `instructions` 字段(与 `QwenOmniLlm.OmniAudioOptions` 兼容,纯加法)。

该接缝为**纯加法**:未注入(`composeOmniInstructions===undefined`)时,omni 直路 MUST 以空 opts 调用
`respondToAudio`,行为与本变更前**逐字一致**。本接缝 MUST NOT 影响 STT 路径(STT 路绝不经过它)。
instructions MUST NOT 包含本轮用户 transcript(omni 模型直接听原始音频,用户这轮说了什么由模型自己听;
instructions 只承载人设/记忆/语气背景)。

#### Scenario: 注入 composeOmniInstructions 时 omni 回合携带 instructions

- **WHEN** 注入吐 `transcript`/`text`/`end` 的 fake omni 端口 + 一个返回固定系统提示的
  `composeOmniInstructions`、语音路径为 omni,驱动一个回合
- **THEN** `omni.respondToAudio` 收到的 opts.instructions 等于该回调返回的系统提示;回合正常产出
  transcript 写记忆 + text→tts:chunk + end→回 listening

#### Scenario: 未注入 composeOmniInstructions 时 omni 回合传空 opts(逐字不变)

- **WHEN** 不注入 `composeOmniInstructions`、语音路径为 omni,驱动一个回合
- **THEN** `omni.respondToAudio` 以空 opts(不含 instructions)被调用,行为与本变更前一致

### Requirement: composeOmniInstructions 失败/超时优雅降级(§3.2)

`composeOmniInstructions` 接缝 MUST 优雅降级,绝不使 omni 回合崩溃、绝不阻塞 omni 首音(§5.5):
当注入的回调**抛错、超时、或返回空串**时,`VoiceLoop` MUST 退回以空 opts 调用 `respondToAudio`
(等价未注入),记日志,omni 回合 MUST 仍能正常推进并在结束/失败时干净回 listening。

#### Scenario: composeOmniInstructions 抛错时退回空 opts 不崩

- **WHEN** 注入的 `composeOmniInstructions` 抛错、语音路径为 omni,驱动一个回合
- **THEN** `VoiceLoop` 捕获错误、以空 opts 调用 `respondToAudio`、回合正常完成回 listening,不崩

### Requirement: Conversation 暴露 omni 系统提示组装(复用既有 prompt 组装)

`Conversation` SHALL 暴露只读方法 `composeOmniInstructions(): Promise<string>`,**复用**与
`Conversation.send` 同一套 prompt 组装(persona 骨架 + 记忆召回 + tone + 立场 + 风格纪律,
即既有 `composeSystem`),返回组装的 `system` 字符串(供 omni 直路当 instructions)。组装时
MUST 以空 userText(omni 无本轮文本)进行,记忆召回沿用既有快路径(不引入 omni 首音前新的网络阻塞,
§5.5)。内部任一步骤失败时,该方法 MUST 兜底返回 persona 骨架(身份最小提示),绝不返回空、绝不抛。

#### Scenario: 返回含人设骨架的系统提示

- **WHEN** 调用 `conversation.composeOmniInstructions()`
- **THEN** 返回的字符串非空且包含 persona 骨架(身份),复用与 `send` 同源的 persona/记忆/语气组装

#### Scenario: 内部组装失败兜底返回骨架

- **WHEN** 内部 `composeSystem` / 召回 / tone 抛错
- **THEN** 该方法返回 persona 骨架(非空),不抛、不返回空

### Requirement: 装配层为 omni 路注入 composeOmniInstructions

`cli --voice` 装配层 SHALL 在语音模式下把 `composeOmniInstructions` 注入 `VoiceLoop`:
`VoiceModeDeps` MUST 接受一个**可选** `composeOmniInstructions?`,`startVoiceMode` MUST 仅在提供时
透传进 `loopDeps`;`cli.ts` MUST 以 `() => convo.composeOmniInstructions()`(与文字链路同一 Conversation)
注入,使 omni 路与 STT 路同源 persona/记忆/语气。未提供时(或非 omni 路)MUST 不影响装配与现有行为。

#### Scenario: 语音模式注入与 Conversation 同源的 composeOmniInstructions

- **WHEN** `cli.ts` 启动语音模式
- **THEN** 透传给 `startVoiceMode` 的 `composeOmniInstructions` 调用的是 `convo.composeOmniInstructions`
  (与文字链路同一 Conversation 实例的 persona/记忆/语气组装)

### Requirement: voice 配置块解析为 VoiceProfile

系统 SHALL 提供 voice 配置块加载器 `loadVoiceProfile(env)`(providers),把环境变量解析为 `VoiceProfile { inputLang?, outputLang?, voiceId?, cloneRef? }`(承 §4.1 输入/输出语种解绑、用户配置)。来源:`CHAT_A_VOICE_INPUT_LANG`(`auto`|语种码,缺省/`auto`=自动检测)/ `CHAT_A_VOICE_OUTPUT_LANG`(缺省空=不强制)/ `CHAT_A_VOICE_ID` / `CHAT_A_VOICE_CLONE_REF`(refAudio 路径)+ `CHAT_A_VOICE_CLONE_REF_TEXT` / `CHAT_A_VOICE_CLONE_REF_LANG`。`input_lang` 取 `auto`(大小写不敏感)或空时 `inputLang` SHALL **省略键**(自动检测);`output_lang` 空时 `outputLang` SHALL **省略键**。`cloneRef` SHALL 仅在 `CHAT_A_VOICE_CLONE_REF` 非空时产出。各未设字段 MUST 省略键(exactOptionalPropertyTypes,绝不显式 `undefined`)。阈值/默认 MUST 外置(行为即配置,§3.2),无 magic number。

#### Scenario: 全空 env → 空 profile

- **WHEN** 所有 `CHAT_A_VOICE_*` 均未设置
- **THEN** `loadVoiceProfile` 返回的 `VoiceProfile` 各键均缺席(`inputLang`/`outputLang`/`voiceId`/`cloneRef` 全省略)

#### Scenario: input_lang=auto 等价自动检测

- **WHEN** `CHAT_A_VOICE_INPUT_LANG=auto`(或空)
- **THEN** `VoiceProfile.inputLang` 缺席(键省略)

#### Scenario: 配置语种与音色复刻

- **WHEN** `CHAT_A_VOICE_INPUT_LANG=en`、`CHAT_A_VOICE_OUTPUT_LANG=zh`、`CHAT_A_VOICE_ID=xiaoxue_v2`、`CHAT_A_VOICE_CLONE_REF=/path/ref.wav`、`CHAT_A_VOICE_CLONE_REF_TEXT=你好`、`CHAT_A_VOICE_CLONE_REF_LANG=zh`
- **THEN** `VoiceProfile` 为 `{ inputLang:'en', outputLang:'zh', voiceId:'xiaoxue_v2', cloneRef:{ source:'/path/ref.wav', refText:'你好', refLang:'zh' } }`

### Requirement: VoiceLoop 经注入透传输入/输出语种与音色

`VoiceLoop` SHALL 经注入(`VoiceLoopDeps.sttLanguage?: string` 与 `ttsOptions?: TtsOptions`,**不直接 import providers config**,§3.1)把语种/音色透传给 STT/TTS:转写处在 `sttLanguage` 提供时以 `SttOptions.language` 传给 `transcribe`;合成处在 `ttsOptions` 提供时把它传给 `synthesize`(`output_lang`→`language`、`voice_id`→`voiceId`、`clone_ref`→`refAudio`)。**当二者均未注入时**,`transcribe` MUST NOT 传 `opts.language`(自动检测)且 `synthesize` 的 opts MUST 为 `undefined`——调用形状与未引入本接线时**字面等价**(逐字现状)。语种不支持时 SHALL 经既有能力门(`assertSttLanguage`/`assertTtsLanguage`,§4.3)在 provider 内 fail-fast,VoiceLoop 既有 try/catch 降级不崩(§3.2)。

#### Scenario: 注入 input_lang → STT 收到 language

- **WHEN** 注入 `sttLanguage='en'`,VoiceLoop 转写一段音频
- **THEN** `stt.transcribe` 收到的 `opts.language === 'en'`

#### Scenario: 注入 output_lang/voice_id/clone_ref → synthesize 收到对应 opts

- **WHEN** 注入 `ttsOptions={ language:'zh', voiceId:'xiaoxue_v2', refAudio:{ source:'/r.wav' } }`,VoiceLoop 合成一句
- **THEN** `tts.synthesize` 收到的 opts 含 `language:'zh'`、`voiceId:'xiaoxue_v2'`、`refAudio.source:'/r.wav'`

#### Scenario: 未注入 → 调用形状逐字现状(回归绿)

- **WHEN** 未注入 `sttLanguage` 与 `ttsOptions`
- **THEN** `transcribe` 调用不带 `opts.language`(自动检测)、`synthesize` 的 opts 为 `undefined`,行为与未引入本接线时逐字一致

#### Scenario: 语种不支持 fail-fast 不崩

- **WHEN** 注入了 provider 能力集不含的语种(如 STT `languages=['zh']` 但 `sttLanguage='ja'`)
- **THEN** provider 经 `assertSttLanguage` 抛清晰错误,VoiceLoop 捕获并降级回 listening,绝不崩(§3.2)

### Requirement: cli 按 voice profile 装配且缺省关回归绿

cli SHALL 在语音模式按 `loadVoiceProfile(env)` 装配:把 `inputLang` 透传为 VoiceLoop 的 `sttLanguage`、由 `outputLang`/`voiceId`/`cloneRef` 拼 `ttsOptions` 透传给 VoiceLoop;并把 `outputLang` 注入 `Conversation`(使文字路也按输出语种回复)。各项 SHALL 仅在 profile 对应键存在时透传(`exactOptionalPropertyTypes` 友好)。当 voice profile 各键缺席(env 全空)时,cli MUST NOT 透传任何语种/音色,**全链路行为与未引入本接线时逐字一致**(缺省安全)。

#### Scenario: 缺省全空 → 全链路不变

- **WHEN** 未设置任何 `CHAT_A_VOICE_*`(且无 card voice 段)
- **THEN** cli 不透传 `sttLanguage`/`ttsOptions`/`outputLang`,STT 自动检测、synthesize opts=undefined、系统提示无输出语种段,行为逐字一致

### Requirement: 装配层 EchoGuard 去抖默认(语音模式默认开 + 真去抖)

语音模式装配 SHALL 提供 `loadEchoGuardConfig(env)`,据 `CHAT_A_ECHO_GUARD` 决定是否注入 EchoGuard 配置到 VoiceLoop:

- `CHAT_A_ECHO_GUARD` 取 `off` / `false` / `0` / `no` / `disabled`(大小写不敏感、去空白)时 MUST 返回 `undefined`(VoiceLoop 不注入 EchoGuard → barge-in 逐字现状即时打断,回归硬线、优雅降级 §3.2)。
- 其余值 / 缺省时 MUST 返回 `enabled:true` 的配置(语音模式**默认开启**自打断防护)。

返回的配置 MUST 把 `confirmFrames` 设为**去抖值 `3`**(≈30ms,10ms/帧)而非沿用库默认 `1`:需连续 3 帧高置信语音才确认是用户真说话→才打断,压制自家 TTS 经空气/回环灌进麦克风的单帧回声尖峰与瞬态噪声误打断(§4 自打断防护软件侧缓解真正生效)。其余阈值沿用 `DEFAULT_ECHO_GUARD_CONFIG`(`minSpeechProb`/`minEnergy`/`cooldownMs`/双层 RMS 门槛)。3 帧 ≈30ms 远低于人类反应/感知阈,伴侣仍「能被打断」(不变迟钝);此值即「最短连续语音时长门槛」,无需再叠独立的 min-interruption 时长护栏(职责等价、避免重复工程)。

本切片 MUST NOT 新增 `confirmFrames` 专属 env 旋钮(避免过度工程);`CHAT_A_ECHO_GUARD` 开关语义保持不变。

#### Scenario: 缺省 → 默认开且去抖值为 3

- **WHEN** `env` 不含 `CHAT_A_ECHO_GUARD`
- **THEN** `loadEchoGuardConfig(env)` 返回 `enabled:true` 且 `confirmFrames:3`(默认开启自打断防护、真去抖)

#### Scenario: 显式关闭 → 不注入(回落现状)

- **WHEN** `CHAT_A_ECHO_GUARD` 为 `off`(或 `false`/`0`/`no`/`disabled`)
- **THEN** `loadEchoGuardConfig(env)` 返回 `undefined`(VoiceLoop 不注入 EchoGuard,barge-in 逐字现状即时打断)

#### Scenario: 其它非关闭值 → 仍默认开且去抖

- **WHEN** `CHAT_A_ECHO_GUARD` 为 `on`(或任意非关闭值)
- **THEN** `loadEchoGuardConfig(env)` 返回 `enabled:true` 且 `confirmFrames:3`

#### Scenario: cli 与 desktop 共用装配路径同得去抖默认

- **WHEN** cli 语音入口或 desktop `voiceStart` 经共用的 `startVoiceMode(deps)`(传 `env`)启动语音
- **THEN** 二者均经同一 `loadEchoGuardConfig(env)` 注入 EchoGuard;缺省下 desktop 与 cli 同样得到 `enabled:true`/`confirmFrames:3` 的去抖默认(desktop 不存在「漏注入 EchoGuard」缺口)

### Requirement: omni 直路把用户语气情绪经显式标签喂进 PAD(prosody→PAD)

omni audio-in 直路(path B)SHALL 把用户说话的语气情绪经**显式机读标签链路**喂进 PAD 情感内核,落地 canonical §7 底线「带情绪的语音(prosody)永不漏听」。该能力为**纯加法**:在**不注入** `advanceProsody` 钩子、模型**未给**标签、或标签**解析失败**的任一情形下,omni 直路的行为与产出 MUST 与本能力引入前**逐字一致**(仅没有 prosody→PAD,等于现状)。

落地分三处:

1. **omni instructions 注入标签门控指令**:omni 直路系统提示组装(`composeOmniInstructions`)SHALL 在末尾追加一段指令,要求模型在回复**末尾**附一个机读标签 `[user_emotion:<label>-<intensity>]`——`label` 取与 STT 一致的 7 类情绪集合(`surprised`/`neutral`/`happy`/`sad`/`disgusted`/`angry`/`fearful`),`intensity` 为 1–10 的整数。该指令 MUST **仅作用于 omni 直路**;STT 路与文字路的系统提示 MUST NOT 受其影响(`Conversation.send` 走的 `composeSystem` 不注入此指令)。

2. **VoiceLoop 剥标签**:omni 回合累积回复时,`VoiceLoop` SHALL 以一个确定性纯函数从**回复尾部**解析 `[user_emotion:...]` 标签,并在喂 TTS、写显示/记忆之前将其**剥除**。标签 MUST NOT 被合成念出、MUST NOT 进入半句写回的记忆内容。多个标签出现时取**最后一个**;畸形/无标签 → 视作无情绪(零拉力)。

3. **可选钩子推进 PAD**:`VoiceLoop` SHALL 在 `VoiceLoopDeps` 上接受一个**可选**钩子 `advanceProsody?: (emotion: SttEmotionLike) => void | Promise<void>`。当注入了该钩子且 omni 回合解析出合法情绪时,`VoiceLoop` MUST 把映射好的 `SttEmotionLike` 喂给它(由装配层接到 persona 的 prosody-only 推进通道,复用现成 `prosodyToPadPull`,不新写映射)。钩子缺省不注入时 MUST 不调用(omni 路逐字现状)。钩子抛错/拒绝 MUST 被捕获且 MUST NOT 中断回合(§3.2 降级)。

本能力 MUST NOT 改动 STT 路径,MUST NOT 新增 `VoiceState` 或 `VoiceBusEvent`,MUST NOT 在本切片做 omni 路的 persona 全演化/亲密度推进/助手写记忆(那是更大范围,明确不做)。

#### Scenario: 未注入钩子 → omni 路逐字现状

- **WHEN** 不注入 `advanceProsody` 钩子、语音路径为 omni,驱动一个完整 omni 回合(模型回复尾部即便带标签)
- **THEN** 钩子零调用、PAD 不被本链路推进;回复中的标签仍被剥除后再进 TTS/显示(绝不念出标签),其余产出与本能力引入前一致

#### Scenario: 模型给标签 → 剥离后喂 PAD

- **WHEN** 注入 `advanceProsody` 钩子、omni 端口的 `text` 事件累积成形如 `…正文…[user_emotion:sad-7]` 的回复
- **THEN** `VoiceLoop` 从尾部解析出 `{label:'sad', confidence≈0.7}` 并调用 `advanceProsody`;喂 TTS 的句子与累积文本中**不含**该标签(标签不被念出、不进记忆)

#### Scenario: 无标签 / 畸形标签 → 零情绪降级

- **WHEN** 模型回复**不含** `[user_emotion:...]` 标签,或标签 label 不在 7 类集合内 / intensity 非法
- **THEN** `advanceProsody` 不以非法情绪被调用(无标签时不调用;label 非法时按零情绪处理,不污染 PAD);回复正文照常进 TTS/显示,回合不受影响

#### Scenario: 多标签取最后一个

- **WHEN** 回复中出现多个 `[user_emotion:...]` 标签
- **THEN** 解析取**最后一个**标签作为本轮 prosody 情绪;所有标签均从进 TTS/显示的文本中剥除

#### Scenario: 钩子抛错不中断回合

- **WHEN** 注入的 `advanceProsody` 钩子在被调用时抛错或返回 rejected Promise
- **THEN** 错误被捕获并记 warn,omni 回合照常推进(分句→TTS→收尾),绝不崩

#### Scenario: 标签指令仅作用 omni 路

- **WHEN** 走 STT 路径或文字路径(`Conversation.send`)产出系统提示
- **THEN** 系统提示中**不含** `[user_emotion:...]` 标签指令(STT 路情绪来自 qwen-asr,文字路无语音),其产出与本能力引入前逐字一致

