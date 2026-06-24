## ADDED Requirements

### Requirement: 无原生依赖的 WAV 文件音频设备(默认关)

系统 SHALL 提供 `WavFileAudioDevice`,实现既有 `AudioDevice` 接缝,**仅用 Node 内置 `node:fs`、零原生依赖**:从 16kHz/mono/s16le 的 WAV 读音频帧充当「麦克风输入」,把 TTS 下行块累积编码为 WAV 写文件充当「扬声器输出」。该设备 MUST 经 cli 配置 `CHAT_A_AUDIO_DEVICE=wav` 选用;缺省/任何非该值 MUST 仍走 `fake`(缺省行为逐字不变)。采集 MUST 产出递增 `timestampMs`(按 10ms/帧步进)以供 VAD/EOU 时间对齐。设备 MUST 可注入(输入可传 WAV 路径或直接传 `PcmFrame[]`;调度/时钟可注入)以便确定性单测。输入 WAV 头部不符 16k/mono/s16le 时 MUST 明确报错(不静默吞)。所有方法在 `close` 后 MUST 为安全 no-op(§3.2)。

#### Scenario: 采集逐帧回放注入音频

- **WHEN** 用注入的 `PcmFrame[]`(或 16k/mono/s16le WAV)+ 注入调度构造 `WavFileAudioDevice` 并 `captureStart(onFrame)`
- **THEN** `onFrame` 按帧序列逐帧回调,每帧 160 样本、`timestampMs` 按 10ms 步进;`close` 后不再回调

#### Scenario: 播放累积产出可解码 WAV

- **WHEN** 多次 `play(chunk)` 送入 Int16 PCM 块,然后 `close`(或 flush)
- **THEN** 产出的 WAV 字节可被解码还原出与输入块一致的样本序列与采样率

#### Scenario: 缺省不启用,行为不变

- **WHEN** `CHAT_A_AUDIO_DEVICE` 未设置或为非 `wav` 值
- **THEN** cli 装配仍构造既有设备(缺省 `FakeAudioDevice`),不构造 `WavFileAudioDevice`,语音链路行为逐字不变

### Requirement: 无模型能量阈值 VAD(默认关)

系统 SHALL 提供 `EnergyVadDetector`,实现既有 `VadDetector` 接口,用逐帧 RMS 能量(归一化到 0~1)替代 ONNX 模型推理,复用既有 `VadGate` 去抖状态机产出 `speech_start`/`speech_end` 事件。该检测器 MUST **无 ONNX、无模型文件、无原生依赖**。阈值 MUST 经配置(`EnergyVadConfig`,无 magic number)。该档 MUST 经 cli 配置 `CHAT_A_VAD=energy` 选用;缺省/任何非真档值 MUST 仍走确定性桩(缺省行为逐字不变)。构造失败时 MUST 明确提示并回落桩(沿用既有真 VAD 回落范式,绝不崩,§3.2)。

#### Scenario: 高能量帧触发 speech_start

- **WHEN** 喂入连续高能量(高 RMS)帧达去抖阈
- **THEN** 产出 `speech_start` 事件,后续连续低能量帧达阈产出 `speech_end`

#### Scenario: 缺省不启用,行为不变

- **WHEN** `CHAT_A_VAD` 未设置或非真档值
- **THEN** `createDetectors` 返回确定性桩(`StubVadDetector`),不构造 `EnergyVadDetector`,detect 行为逐字不变

### Requirement: 无模型静音超时 EOU(默认关)

系统 SHALL 提供 `SilenceTimeoutEouModel`,实现既有 `EouModel` 接口,据音频窗尾连续低能量(静音)累积时长判定「已说完」概率,**无模型文件、无原生依赖**:窗尾静音累积 ≥ `silenceTimeoutMs` → 高 eouProb;否则低。阈值 MUST 经配置(`SilenceEouConfig`,无 magic number)。该 EOU MUST 与既有 `DynamicEndpointing` 策略层正交可组合(只补「概率源」)。该档 MUST 随 `CHAT_A_VAD=energy`(无模型档)一并选用,缺省仍走 `StubEouModel`(缺省行为逐字不变)。

#### Scenario: 窗尾静音达阈判已说完

- **WHEN** 传入窗尾为连续低能量、累积时长达 `silenceTimeoutMs` 的音频窗
- **THEN** `predict` 返回高 eouProb(接近 1);窗尾为有声时返回低 eouProb

#### Scenario: 缺省不启用,行为不变

- **WHEN** 无模型档未启用
- **THEN** `createDetectors` 的 EOU 仍为 `StubEouModel`,行为逐字不变

### Requirement: DashScope 云 STT「填 key 即用」(复用 OpenAI 兼容接缝)

系统 SHALL 让用户仅凭 `CHAT_A_DASHSCOPE_API_KEY` 即可启用 DashScope 云语音转文字:`loadSttConfig` 在 `CHAT_A_STT_KIND=qwen` 时 SHALL 产出 `openai-compat` STT 配置,默认 `model=qwen3-asr-flash`、`baseURL=https://dashscope.aliyuncs.com/compatible-mode/v1`、`apiKey` 回落 `CHAT_A_DASHSCOPE_API_KEY`,经既有 `OpenAiCompatStt`(POST `/audio/transcriptions` 上传 WAV)工作——**STT registry/provider 零改**。`CHAT_A_STT_MODEL` / `CHAT_A_STT_BASE_URL` MUST 可覆盖默认。缺省(无 key 且未显式配 STT)MUST 仍回落 `fake`(缺省行为逐字不变)。日志/错误 MUST NOT 含密钥明文。

#### Scenario: qwen 档解析为 DashScope OpenAI 兼容配置

- **WHEN** `CHAT_A_STT_KIND=qwen` 且 `CHAT_A_DASHSCOPE_API_KEY` 已设
- **THEN** `loadSttConfig` 返回 `kind='openai-compat'`、`model='qwen3-asr-flash'`、`baseURL` 为 DashScope 兼容端点、`apiKey` 取 DashScope key

#### Scenario: 缺省无 key 仍回落 fake

- **WHEN** `CHAT_A_STT_KIND` 未设且无任何 STT key
- **THEN** `loadSttConfig` 返回 `kind='fake'`(回归,缺省行为逐字不变)

### Requirement: 一键「填 key 即测」命令与中文 quickstart

系统 SHALL 提供一条 **100% key-only 可跑路径**:文本输入 → 云 LLM(`qwen`)→ 云 TTS(`qwen-tts`)→ WAV 文件,仅需 `CHAT_A_DASHSCOPE_API_KEY` + 网络(跳过 STT/麦克风)。根 `package.json` SHALL 提供 `test:voice` 脚本跑通该路径。README SHALL 增中文 quickstart:一句「把 key 填进 `.env.local` 的 `CHAT_A_DASHSCOPE_API_KEY`,跑该命令」,并列清涉及 env 开关默认值,且 SHALL 标注「全语音(WAV→STT→…)」为「云 STT 待真网络确认」、「真麦克风/扬声器仍需 naudiodon(原生,本路径不解决)」。

#### Scenario: 命令与文档就位

- **WHEN** 查看根 `package.json` 与 README
- **THEN** 存在 `test:voice` 脚本与中文 quickstart 段落,明确区分「100% key-only 路径」与「待真网络确认路径」,并说明真麦克风仍需原生库

### Requirement: Qwen WS 连通性 smoke 脚本(真网络,默认不进 CI)

系统 SHALL 提供 `scripts/qwen-smoke.ts`:有 `CHAT_A_DASHSCOPE_API_KEY` + 真网络时真连 `qwen-tts`(真 WebSocket 握手 + 收 PCM,存一段 WAV)以验证 key/网络通;无 key 时 MUST 跳过并打印中文提示、以 0 退出。该脚本 MUST 标注「需真网络、手动跑、默认不进 CI」,且 MUST NOT 打印密钥明文。

#### Scenario: 无 key 时优雅跳过

- **WHEN** 运行 `qwen-smoke` 但 `CHAT_A_DASHSCOPE_API_KEY` 未设
- **THEN** 打印「跳过(需真网络 + key)」中文提示并以退出码 0 结束,不抛栈、不触网
