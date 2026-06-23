## Why

`@chat-a/voice-detect` 三层接缝（VAD / TurnDetector·EOU / 动态 endpointing）齐备,但 VAD 与 EOU 当前**只有确定性桩**(`StubVadDetector` 按注入概率走、`StubEouModel` 同理)。这意味着 VoiceLoop 端到端虽闭环,真正的「免提连续对话」端点检测**还不真**:小雪无法靠声学/韵律判断「用户有没有在说话」「这句说完没」,`cli --voice` 也只能用「恒有声 + 高 EOU」占位序列装配(`packages/client/src/cli-voice.ts:89-92`)。

接入真 **Silero VAD**(有没有声)+ **Smart-Turn v3**(说完没,§5b 行 100/105)是 §4/P2 语音管线收尾的关键一环——且 canonical §4 行 173 已明确「纯 CPU,本地 mini ONNX 可跑(树莓派友好)」,与部署目标一致。

## What Changes

- **新增 `SileroVadDetector`**(实现既有 `VadDetector` 接缝):注入式**同步**推理端口 `VadInferenceSession`,把累积的 16k 帧缓冲成 Silero 习惯的窗口(默认 512 样本/32ms)逐窗推理得语音概率,**复用现有 `VadGate` 去抖状态机**产出 `speech_start/end`。
- **新增 `SmartTurnEouModel`**(实现既有 `EouModel` 接缝):注入式**同步**推理端口 `EouInferenceSession`,把累积用户音频窗(韵律,非转写)喂模型得「已说完」概率,交给既有 `DynamicEndpointing` 定夺。**复用现有 endpointing 策略与 TEN 3 态映射,零改。**
- **新增确定性 Fake 推理端口**(`FakeVadInferenceSession` / `FakeEouInferenceSession`):按注入序列/规则同步产出概率,供 CI 测真适配器的「缓冲/窗口/状态复位」逻辑,**不碰真模型/真音频/真时钟**(承 §3.2 可测试性)。
- **config 增补**:VAD 推理窗口大小、目标采样率;EOU 音频窗时长/采样率/归一化等**全部外置到 `config.ts`**(行为即配置,无 magic number)。
- **真引擎接入路径文档化**:真 Silero / Smart-Turn v3 经 **sherpa-onnx 同步原生绑定**(其 Node VAD 推理为同步阻塞,契合同步接缝;呼应 canonical §9 行 324 Sherpa-ONNX 方向)注入,**手测**;真模型/真音频 headless 跑不了,不进 CI。
- **零改 VoiceLoop / Conversation / 总线**:新实现与桩同接口,注入替换即生效(`cli-voice.ts` 后续切片换注入)。

### Non-goals

- 不写 onnxruntime/sherpa-onnx 原生依赖进 CI 依赖图,不在本环境跑真麦克风/真模型(沿用 whisper-local/kokoro 注入式隔离纪律)。
- 不改 `cli-voice.ts` 的真模型装配(真端口注入是后续切片;本切片只交付可注入的真适配器 + 同步端口契约 + Fake + 测试)。
- 不动附和/打断分类(canonical §4 行 571,后续启发式/自建)。
- 不引入异步推理重构:接缝保持同步(VoiceLoop 同步调用 `pushFrame`/`step`,§4.2 B 层不变)。

### 对延迟预算的影响(§3.2)

推理同步内联在 `pushFrame`/`predict`:VAD 单窗(512 样本)RNN 推理 sub-ms 级、纯 CPU;EOU 按窗触发非每帧。延迟特性由真模型在真硬件上手测标定,本切片只固定**同步、单窗、可降级**(端口抛错 → VAD 视作静音/EOU 视作未说完,回合不崩,承 §3.2 优雅降级)的接缝形状,不新增链路阻塞点。

## Capabilities

### New Capabilities
- `voice-detection`: VAD(有没有声)与 EOU/TurnDetector(说完没)的**真模型接入契约**——可注入的同步声学推理端口、Silero 窗口缓冲与 Smart-Turn 音频窗喂入语义、复用既有去抖/动态 endpointing、确定性 Fake 与降级行为。

### Modified Capabilities
<!-- 无:VoiceLoop/Conversation/总线零改;现有 endpointing/VadGate 逻辑复用不变,不改其 spec-level 行为。 -->

## Impact

- **代码**:`packages/voice-detect/src/`(新增 `silero-vad.ts`、`smart-turn-eou.ts`,或就近扩展 `vad.ts`/`turn-detector.ts`)+ `config.ts`(增窗口/采样率/窗时长配置)+ `index.ts`(导出)+ `test/`(Fake 端口驱动的适配器测试)。
- **接缝**:实现既有 `VadDetector` / `EouModel` 接口(§3.1 接缝边界),不新增跨模块依赖;新增的 `VadInferenceSession` / `EouInferenceSession` 端口**不暴露 onnxruntime/sherpa 类型**(最小面,沿用 whisper-local `SpawnFn` / kokoro `KokoroSession` 注入纪律)。
- **依赖**:CI 依赖图**不变**(无原生包);真引擎经运行时动态注入(后续切片)。
- **canonical 章节**:§4(行 159 三层各司其职 / 行 173 EOU 驱动动态 endpointing)、§5b(行 100 Smart-Turn v3 / 行 105 Silero 16k/512)、§9(行 324 Sherpa-ONNX 量化方向);与权威设计一致,无冲突。
