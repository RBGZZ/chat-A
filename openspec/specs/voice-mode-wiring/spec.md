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

