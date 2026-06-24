# 设计:key-only-test-harness

## 背景与约束

- 真麦克风/扬声器 I/O 必须原生库(naudiodon,需 MSVC);**这条 key 解决不了**,不在本 change 处理。
- 目标:**只填 `CHAT_A_DASHSCOPE_API_KEY` 就能测**,故全云端 provider + 文件/文本 I/O + 无模型 VAD/EOU。
- 严守开发 5 原则:可测试性(Fake/注入、不触网)、延迟预算(新档不进真热路径)、优雅降级(失败回落不崩)、行为即配置(env 开关、缺省不变)、数据迁移纪律(无 schema 改动)。

## 决策 1:WAV 文件音频设备(`WavFileAudioDevice`)

**实现 `AudioDevice` 接口**(`packages/client/src/audio/audio-device.ts`),与 `FakeAudioDevice`/`NodeAudioDevice` 平级。

- **采集**:构造时给输入 WAV 路径 → 读文件 → 解析 RIFF/WAVE 头(断言 16k/mono/s16le,不符则明确报错或重采样拒绝)→ data 段按 `SAMPLES_PER_FRAME`(160 样本/10ms)切帧 → `captureStart(onFrame)` 把帧序列**异步逐帧**回放(用注入式 `schedule`,缺省 `setTimeout` 0 排队,保持非阻塞;`close` 后停)。带递增 `timestampMs`(从 0 或注入起点按帧步进 10ms),供 EOU/VAD 时间对齐。
- **播放**:`play(chunk)` 把下行 Int16 PCM **累积到内存缓冲**(记 sampleRate);`close`(或显式 `flush`)时把累积缓冲编码成 WAV 写到输出路径。`playStop` 记一次停止(对齐打断语义;可清当前累积或保留,默认保留以便听完整产出)。
- **纯 `node:fs`**:WAV 编/解码用本地纯函数(复用 `openai-compat-stt.ts` 里已验证的 `encodeWav` 思路;为 client 侧独立实现一份解码 + 编码,避免跨包 import provider 内部私有函数)。
- **可注入/可测**:输入可传 WAV 路径**或**直接传 `PcmFrame[]`(测试免落盘);输出路径可省(只留内存缓冲供断言)。`schedule`/`now` 可注入(确定性测试)。

**为什么不复用 Fake**:Fake 采集恒空、播放只记内存不落盘——既喂不了真音频给云 STT,也存不下云 TTS 产出供试听。WAV device 正补这两头。

## 决策 2:无模型 VAD(`EnergyVadDetector`)+ 静音超时 EOU(`SilenceTimeoutEouModel`)

放 `packages/voice-detect/src/`,各实现既有 `VadDetector` / `EouModel` 接口,**零改 VoiceLoop**。

- **`EnergyVadDetector`**:逐帧算 RMS(`sqrt(mean(sample^2))`)→ 归一化到 0~1(除以 Int16 满量程 32768)→ 当作「语音概率」喂**既有 `VadGate`**(复用同一套去抖/start-end 状态机)。阈值经新增 `EnergyVadConfig`(`rmsThreshold` 等,行为即配置,无 magic number)。**无 ONNX、无模型文件、无原生依赖**。
- **`SilenceTimeoutEouModel`**:实现 `EouModel.predict(window)`。思路:跟踪「连续静音时长」——每次 `predict` 由调用方传入的窗 + 内部累积判断;但 `EouModel.predict` 只吃 window 不吃 silenceMs,故本模型据**窗尾若干帧的能量**判定:窗尾连续低能量帧数 × 帧时长 ≥ `silenceTimeoutMs` → 返回高 eouProb(≈1),否则低(≈0)。这样无需模型即可对真音频「停顿」有反应。阈值经新增 `SilenceEouConfig`。
  - 注:`TurnDetector` 已把 `silenceMs` 喂给 `DynamicEndpointing` 策略层;本 EOU 只补「概率源」,与既有动态 endpointing 正交、可组合。

**回落范式**:cli `createDetectors` 已有「真路径失败→回落桩」结构;新增 `energy` 档与 `silero` 档平级,构造失败同样明确提示并回落桩。

## 决策 3:云 STT「填 key 即用」(复用 `OpenAiCompatStt`,零新 provider)

DashScope 提供 **OpenAI 兼容** `/v1/audio/transcriptions`(模型 `qwen3-asr-flash`,音频 < 10MB),base URL `https://dashscope.aliyuncs.com/compatible-mode/v1`,Bearer key = 同一个 DashScope key。既有 `OpenAiCompatStt` 正是 POST multipart WAV 到 `${baseURL}/audio/transcriptions`——**协议天然对齐**。

- `stt-config.ts` 加一个**便捷档**:`CHAT_A_STT_KIND=qwen`(或检测到 `CHAT_A_DASHSCOPE_API_KEY` 且未显式配 STT)→ 产出 `openai-compat` 配置:`model='qwen3-asr-flash'`、`baseURL=…/compatible-mode/v1`、`apiKey` 回落 `CHAT_A_DASHSCOPE_API_KEY`、`id='qwen-asr'`。**registry/provider 零改**(仍走 `openai-compat` 分支)。
- 各专有项(model/baseURL)可经既有 `CHAT_A_STT_MODEL` / `CHAT_A_STT_BASE_URL` 覆盖。
- **风险/降级**:Qwen3-ASR 官方示例多用「音频 URL via JSON」;OpenAI 兼容端点的 multipart 文件上传往返本 change **不触网验证**,标注「云 STT 待真网络确认」。若真机证实 multipart 不通,改 config 一处即可(爆炸半径可控)。**100% key-only 路径不依赖 STT**(见决策 4)。

## 决策 4:分层交付——哪条 100% key-only,哪条待确认

- **A. 100% key-only(绝对可跑)**:**文本输入 → 云 LLM(`qwen`)→ 云 TTS(`qwen-tts`)→ WAV 文件**。跳过 STT/麦克风,只需 DashScope key + 网络。这是 `pnpm test:voice` 跑的路径。
  - 实现:既有文字 REPL(LLM)已可用;TTS 经 `qwen-tts` 合成,产出经 `WavFileAudioDevice`(或脚本直接调 TTS provider)落 WAV。`test:voice` 用一个最小脚本/预设把这条串起来(优先用脚本直驱 LLM→TTS→WAV,避免依赖语音 loop 的麦克风采集)。
- **B. 待真网络确认**:**全语音(WAV 输入 → 云 STT → 云 LLM → 云 TTS → WAV 输出)**。device=wav + STT=qwen + VAD=energy/stub。能接但 STT multipart 往返待 smoke/真机确认。

## 决策 5:一键命令 + smoke 脚本

- `package.json` 加 `"test:voice"`:设好 `CHAT_A_*` 预设档跑路径 A 的脚本(`tsx scripts/voice-text-to-wav.ts` 或经 cli 预设)。**不进 CI**(需真 key)。
- `scripts/qwen-smoke.ts`:有 `CHAT_A_DASHSCOPE_API_KEY` → 真连 `qwen-tts`(真 WS,合成一句存 WAV)+ 可选真连云 STT 回读;无 key → 打印「跳过(需真网络 + key)」并 exit 0。**标注真网络、手动跑、默认不进 CI**。

## 不做(范围外)

- 真麦克风/扬声器(naudiodon)——原生依赖,本 change 不碰。
- 重采样器(若 WAV 非 16k 直接报错提示,不内置重采样)——避免范围膨胀;quickstart 注明输入 WAV 须 16k/mono/s16le。
- 不碰 runtime voice-loop 内部、autonomy、assembly/autonomy.ts。

## 测试策略(全 Fake/注入、不触网、不碰真硬件)

- WAV 编解码往返(encode→decode 还原样本)、头部断言(非 16k/mono 报错)。
- `WavFileAudioDevice`:注入 `PcmFrame[]` + 注入 schedule → 采集逐帧回调;`play` 累积 → `close` 产出 WAV 字节可解码还原。
- `EnergyVadDetector`:构造高/低能量帧序列 → 断言 RMS 概率 + speech_start/end 事件(复用 VadGate 去抖)。
- `SilenceTimeoutEouModel`:窗尾静音达阈 → 高 eouProb;有声 → 低。
- `loadSttConfig`:`CHAT_A_STT_KIND=qwen` / 仅 DashScope key → 产出正确 openai-compat 档(model/baseURL/key 回落);缺省无 key → 仍 `fake`(回归)。
- 开关默认值回归:`CHAT_A_AUDIO_DEVICE` 缺省 → fake;`CHAT_A_VAD` 缺省 → stub。
