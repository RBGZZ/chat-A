# voice-detection Specification

## Purpose
TBD - created by archiving change voice-detect-real-onnx. Update Purpose after archive.
## Requirements
### Requirement: 可注入的同步声学推理端口

系统 SHALL 为 VAD 与 EOU 各提供一个**同步**声学推理端口接口:`VadInferenceSession` 与 `EouInferenceSession`。`VadInferenceSession.infer(samples)` MUST 同步接收一窗 16k mono PCM(`Float32Array`)并同步返回该窗语音概率(0~1);`EouInferenceSession.infer(samples)` MUST 同步接收累积用户音频窗并同步返回「已说完」概率(0~1)。两端口各 MUST 提供 `reset()` 复位内部状态(如 RNN 隐状态)。两端口 MUST NOT 在类型签名上暴露任何 onnxruntime / sherpa-onnx 具体类型(最小面,承 §3.1 接缝纪律,沿用 whisper-local `SpawnFn` / kokoro `KokoroSession` 注入式隔离)。

同步签名是硬约束:`VadDetector.pushFrame` 与 `EouModel.predict` 被 VoiceLoop 同步调用且结果立即使用(`packages/runtime/src/voice-loop.ts`),真引擎经 sherpa-onnx 同步原生绑定满足之(canonical §9 行 324 方向)。

#### Scenario: VAD 端口同步产出概率

- **WHEN** `SileroVadDetector` 攒满一个推理窗并调用 `VadInferenceSession.infer(window)`
- **THEN** 端口同步返回 0~1 概率,`pushFrame` 在同一次同步调用内据此跑去抖并返回 `VadFrameResult`

#### Scenario: EOU 端口同步产出概率

- **WHEN** `SmartTurnEouModel.predict(window)` 被调用
- **THEN** 内部同步调用 `EouInferenceSession.infer(...)` 得概率,同步返回交由动态 endpointing 定夺

#### Scenario: 端口不泄漏原生类型

- **WHEN** 审视 `VadInferenceSession` / `EouInferenceSession` 的类型定义
- **THEN** 入参为 `Float32Array`、出参为 `number`,不出现 onnxruntime / sherpa-onnx 的任何导出类型

### Requirement: SileroVadDetector 缓冲成窗并复用去抖状态机

系统 SHALL 提供 `SileroVadDetector implements VadDetector`,注入一个 `VadInferenceSession`。它 MUST 把逐帧喂入的 `PcmFrame.samples`(协议帧 160 样本/10ms)累积成 Silero 习惯的推理窗(默认 512 样本,窗口大小取自 config),每攒满一窗调用一次 `infer` 得概率;未攒满一窗的 `pushFrame` MUST 复用上一窗概率(不重复推理、不阻塞)。得到概率后 MUST 复用既有 `VadGate`(同一套「概率 → 去抖 → speech_start/end」状态机)产出事件,**不重复实现去抖逻辑**。`reset()` MUST 同时清空样本缓冲、复位 `VadGate`、并调用注入端口的 `reset()`。

#### Scenario: 攒满一窗触发一次推理

- **WHEN** 连续喂入足以攒满一个推理窗的若干 `PcmFrame`
- **THEN** `SileroVadDetector` 对该窗调用恰一次 `VadInferenceSession.infer`,并以返回概率驱动 `VadGate`

#### Scenario: 未满窗复用上一概率不推理

- **WHEN** 喂入的帧尚不足以攒满下一个推理窗
- **THEN** `pushFrame` 复用上一窗概率跑去抖,且本次 NOT 调用 `infer`

#### Scenario: 去抖产出与桩同语义的事件

- **WHEN** 注入的 Fake 端口产生「低→持续高→持续低」的概率序列
- **THEN** 经 `VadGate` 去抖后产出 `speech_start` 继而 `speech_end`,事件 `atMs` 取自触发帧的 `timestampMs`,语义与 `StubVadDetector` 一致

#### Scenario: reset 清缓冲与端口状态

- **WHEN** 回合切换调用 `reset()`
- **THEN** 样本缓冲清空、`VadGate` 复位、注入端口的 `reset()` 被调用,后续推理从干净状态开始

### Requirement: SmartTurnEouModel 喂音频窗并复用动态 endpointing

系统 SHALL 提供 `SmartTurnEouModel implements EouModel`,注入一个 `EouInferenceSession`。`predict(window)` MUST 把累积的 `PcmFrame[]` 拼成模型所需的音频窗(韵律,非转写;窗时长/采样率/归一化取自 config),仅取最近一段窗(上限时长取自 config,防窗无界增长)喂 `infer` 得「已说完」概率并返回。该概率 MUST 原样交由既有 `TurnDetector` + `DynamicEndpointing` 策略与 TEN 3 态映射定夺,**不在本类内重复实现 endpointing 策略**。空窗(无音频)MUST 返回 0(视作未说完),不调用 `infer`。

#### Scenario: 音频窗喂入得概率

- **WHEN** `predict` 收到非空 `PcmFrame[]`
- **THEN** 拼成音频窗(截取最近不超过 config 上限时长)调用 `EouInferenceSession.infer`,返回其概率

#### Scenario: 概率交由既有策略

- **WHEN** `TurnDetector.step` 用 `SmartTurnEouModel` 得到 EOU 概率
- **THEN** 由 `DynamicEndpointing.decide` 据概率 + 静音时长 + 语种产出 `Finished/Unfinished`,行为与注入 `StubEouModel` 时一致

#### Scenario: 空窗不推理

- **WHEN** `predict` 收到空 `PcmFrame[]`
- **THEN** 返回 0(未说完)且 NOT 调用 `infer`

### Requirement: 真适配器全部阈值/窗口外置到 config

`SileroVadDetector` 的推理窗口大小、目标采样率,以及 `SmartTurnEouModel` 的音频窗时长上限、采样率、归一化参数 MUST 全部取自 `config.ts` 的 readonly 配置(承「行为即配置」§3.2),逻辑内 MUST NOT 出现 magic number。这些配置 MAY 被构造参数整表覆盖(profile gate / 热调友好)。

#### Scenario: 默认配置即可构造

- **WHEN** 不传自定义 config 构造 `SileroVadDetector` / `SmartTurnEouModel`
- **THEN** 使用 `config.ts` 的默认窗口/采样率/窗时长,无需在代码中硬编码数值

#### Scenario: 配置可覆盖

- **WHEN** 构造时传入覆盖的窗口大小或音频窗时长
- **THEN** 适配器据传入值缓冲/截窗,不回落默认

### Requirement: 推理端口失败时优雅降级

当注入的 `VadInferenceSession.infer` / `EouInferenceSession.infer` 抛错时,真适配器 MUST 优雅降级而非崩溃(承 §3.2):VAD 推理抛错 MUST 视该窗为静音(概率 0,不误触发 `speech_start`);EOU 推理抛错 MUST 视作「未说完」(概率 0)。降级 MUST NOT 抛出到 VoiceLoop 的 `pushFrame`/`step` 调用点之上(VoiceLoop 自身的 catch 仍是最后兜底)。

#### Scenario: VAD 推理抛错视作静音

- **WHEN** 注入端口的 `infer` 在某窗抛错
- **THEN** 该窗概率按 0 处理,不触发 `speech_start`,`pushFrame` 正常返回,不向上抛

#### Scenario: EOU 推理抛错视作未说完

- **WHEN** 注入端口的 `infer` 抛错
- **THEN** `predict` 返回 0(未说完),`step` 据此不接话,不向上抛

### Requirement: 确定性 Fake 推理端口供 CI

系统 SHALL 提供确定性的 `FakeVadInferenceSession` 与 `FakeEouInferenceSession`(实现对应端口接口),按注入的概率序列或规则同步产出概率,用于在 CI 测真适配器的缓冲/窗口/降级/复位逻辑,**不依赖真模型、真音频、真时钟、真原生库**(承 §3.2 确定性可测)。

#### Scenario: Fake 按序列产出概率驱动适配器测试

- **WHEN** 用注入概率序列的 Fake 端口构造真适配器并喂入帧/窗
- **THEN** 测试可据序列确定性断言「攒窗时机、推理调用次数、产出事件、reset 行为」,全程不触原生依赖

### Requirement: EchoGuard 纯函数去抖 Gate(connected N 帧确认)

`@chat-a/voice-detect` SHALL 提供纯函数确定性去抖件 `EchoGuardGate`(无副作用、无时钟,与 `VadGate` 同范式),用于在 agent 说话期对 barge-in 施加「连续 N 帧高置信语音」确认。Gate 逐帧喂入 `{ prob, energy01, speakingFromVad }`,返回 `{ confirmed, run }`:仅当**连续** `confirmFrames`(N)帧满足「`prob ≥ minSpeechProb` 且 `speakingFromVad` 为真 且(`minEnergy ≤ 0` 或 `energy01 ≥ minEnergy`)」时 `confirmed` 为真;任一帧不达标即把连续计数清零。Gate MUST 提供 `reset()` 清连续计数。配置经 `EchoGuardConfig`(`enabled` / `confirmFrames` / `minSpeechProb` / `minEnergy`),全字段外置无 magic number,并提供 `DEFAULT_ECHO_GUARD_CONFIG`(`enabled:false` / `confirmFrames:1` / `minSpeechProb:0.5` / `minEnergy:0`,安全默认)。

#### Scenario: 禁用即时确认

- **WHEN** `enabled:false` 喂任意帧
- **THEN** `confirmed` 恒为真(等价无去抖,逐字现状)

#### Scenario: N=1 首帧即确认

- **WHEN** `confirmFrames:1`、喂一个 `prob ≥ minSpeechProb` 且 `speakingFromVad` 的帧
- **THEN** 该帧即 `confirmed:true`(与既有「检出语音即打断」时序一致)

#### Scenario: N=3 需连续三帧

- **WHEN** `confirmFrames:3`,喂连续 3 帧高置信语音
- **THEN** 第 3 帧 `confirmed:true`;若其中插入一个低置信/静音帧 → 计数清零,需重新连续 3 帧才确认

#### Scenario: 能量阈值过滤低能量回声

- **WHEN** `minEnergy > 0`,某帧 `prob` 达标但 `energy01 < minEnergy`
- **THEN** 该帧不计入连续帧,`run` 清零(典型回声经空气衰减能量偏低,被滤除)

### Requirement: VoiceLoop speaking 期经 EchoGuard 确认才打断

`VoiceLoop` SHALL 支持可选构造项 `echoGuard?: EchoGuardConfig`。**未注入时**,`speaking` 期 barge-in 行为逐字不变(检出语音即按既有路径打断;等价 N=1 即时确认)——既有 barge-in 回归用例 MUST 全绿。**注入时**,`speaking` 期检出的上行语音帧先喂 `EchoGuardGate`,仅当 Gate `confirmed` 后才进入既有打断路径(未注入 attention → 即时 `#interrupt`;注入 attention → 再经 `evaluateAttention` 按 `attention_mode` 判)。Gate 未确认时 MUST 保持 `speaking`(只感知不打断,不写半句、不 clearBuffer)。`listening` / `endpointing` 期 MUST NOT 经 EchoGuard——端点检测灵敏度逐字不变。EchoGuard 连续计数 MUST 在进入/离开 `speaking`(打断、回合结束、降级回 listening)时 `reset()`。

#### Scenario: 未注入即现状

- **WHEN** 不传 `echoGuard`,`speaking` 期检出语音起点
- **THEN** 行为与现状完全一致(即时进 barge_in_pending → 打断),既有 barge-in 测试时序不变

#### Scenario: 说话期回声样式被压制

- **WHEN** 注入 `echoGuard{enabled:true, confirmFrames:3}`,`speaking` 期喂入断续(连续达标不足 3 帧)的回声样式帧序列
- **THEN** 保持 `speaking`,不打断、不 clearBuffer、不写半句记忆

#### Scenario: 真人连续 N 帧仍能打断

- **WHEN** 同上配置,`speaking` 期喂入连续 ≥ `confirmFrames` 帧高置信语音
- **THEN** 确认真打断:进 barge_in_pending → 回 `listening`,clearBuffer + 半句写回(证明「打得断」,未被削弱成打不断)

#### Scenario: 非说话期灵敏度不变

- **WHEN** 注入 `echoGuard` 后驱动 `listening`/`endpointing` 期的正常端点检测闭环
- **THEN** 结果与未注入 EchoGuard 时一致(EchoGuard 只在 `speaking` 期生效)

### Requirement: 危机/硬打断豁免 EchoGuard 去抖

当 `speaking` 期且注入了 attention 信号通道、其 `buildSignal` 产出的 `UserVoiceSignal` 带 `crisis` 或 `hardInterrupt` 标注时,VoiceLoop MUST **绕过 EchoGuard 的 N 帧去抖**立即进入打断判定(承「救命不可配」§法律底线)——危机/硬打断不被自打断防护拖延。

#### Scenario: 硬打断不被 N 帧拖延

- **WHEN** 注入 `echoGuard{confirmFrames:3}` 且 attention `buildSignal` 标 `hardInterrupt:true`,`speaking` 期单帧检出语音
- **THEN** 立即真打断(不等待连续 3 帧),回 `listening`

