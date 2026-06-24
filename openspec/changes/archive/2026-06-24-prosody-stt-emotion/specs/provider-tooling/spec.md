## ADDED Requirements

### Requirement: SttResult 纯加法携带 prosody 情绪信号

`SttResult` SHALL 新增**可选** `emotion?: SttEmotion` 字段,承载 STT 从语音读出的 prosody 情绪信号(§7#5「听出怎么说的」),且 MUST 为**纯加法**:既有 STT Provider(`fake`/`openai-compat`/`whisper-local`)MUST NOT 设置该键(`exactOptionalPropertyTypes` 下字段缺席),从而既有 `SttProvider` 消费者读到 `undefined`、行为字面不变。

`SttEmotion` MUST 含离散标签 `label: SttEmotionLabel`(枚举:`surprised`/`neutral`/`happy`/`sad`/`disgusted`/`angry`/`fearful`,对齐 qwen3-asr 官方 7 类),并 MAY 含可选 `confidence?: number`。该类型 MUST 与具体 provider 解耦(任何能产 prosody 情绪的 STT 实现皆可填),为后续 realtime ASR 复用同一返回面留接缝。

#### Scenario: 既有 STT provider 不携带 emotion(行为不变)

- **WHEN** 调用 `FakeStt` / `OpenAiCompatStt` / `WhisperLocalStt` 的 `transcribe` 并收集结果
- **THEN** 每条 `SttResult` MUST NOT 含 `emotion` 键(消费者读到 `undefined`),既有断言与 golden 全部保持通过

### Requirement: DashScope qwen3-asr-flash STT Provider(经 OpenAI 兼容 chat/completions 解析 prosody 情绪)

系统 SHALL 通过 STT Provider 注册表把判别联合 `kind:'qwen-asr'` 映射到 `QwenAsrStt` 实现,经 DashScope **OpenAI 兼容 `/chat/completions`** 端点(qwen3-asr 多模态 chat 形态,音频走 `input_audio` base64 Data URL)做**批式**语音转写,并在转写文本之外解析**说话人 prosody 情绪**(承 §7#5、§4.1/§4.3)。加它 MUST 只需在注册表登记工厂,`createStt` 核心 MUST 零改动。

`QwenAsrStt` MUST 实现 `SttProvider`:`transcribe(audio, opts?, signal?)` 把入口 `AsyncIterable<PcmChunk>` 聚合为单个 WAV 上传,产出**一条** `isFinal:true` 的 `SttResult`,其 `text` 取 `choices[0].message.content`、其 `emotion`(若服务端 `choices[0].message.annotations[]` 给出合法 `emotion`)取首条情绪标注映射成 `SttEmotion`;**无 annotations / emotion 非法值时 MUST NOT 设 `emotion` 键**(纯加法,优雅降级)。能力声明 MUST 含 `languages`(默认多语种 `['*']`)、`streaming:false`、`sampleRate:16000`;`transcribe` MUST 先过 `assertSttLanguage` 能力门 fail-fast。

HTTP 调用 MUST 经**可注入 fetch 端口**完成(缺省用全局 `fetch`),以保证单测**不触真网络**。鉴权 MUST 用 `Authorization: Bearer <key>` 请求头,且**任何日志/错误 MUST NOT 含 key 明文**。缺失/空 `apiKey` 构造 MUST fail-fast(提示设置 `CHAT_A_DASHSCOPE_API_KEY`)。默认 base URL/model MUST 为可配置项(无 magic number、不写死日期快照),可经配置/环境变量覆盖。`id` MUST 仅供 trace/日志,业务不得据此分支。

#### Scenario: 解析转写文本与 prosody 情绪

- **WHEN** 注入的 fetch 返回 `choices[0].message.content="今天好累啊"` 且 `choices[0].message.annotations[0].emotion="sad"`,调用 `transcribe`
- **THEN** 产出单条 `SttResult{ text:"今天好累啊", isFinal:true, emotion:{label:'sad'} }`(请求为 `POST {baseURL}/chat/completions`,body 含 `model` + `messages` 内 `input_audio` base64 Data URL),全程不触网

#### Scenario: 无情绪标注时不设 emotion 键

- **WHEN** 注入的 fetch 返回有 `content` 但 `annotations` 缺失/为空/`emotion` 为非法值
- **THEN** 产出的 `SttResult` MUST NOT 含 `emotion` 键(消费者读到 `undefined`,链路按无信号处理)

#### Scenario: 缺 apiKey 与不支持语种 fail-fast

- **WHEN** 以缺失/空 `apiKey` 构造 `QwenAsrStt`,或 `opts.language` 不在能力 `languages` 内
- **THEN** 分别在构造期 / `transcribe` 入口 fail-fast 抛清晰错误(缺 key 提示 `CHAT_A_DASHSCOPE_API_KEY`),不发起请求

#### Scenario: HTTP 错误优雅降级且不泄漏 key

- **WHEN** 注入的 fetch 返回非 2xx(如 500)
- **THEN** `transcribe` 抛带 status 与正文片段的清晰中文错误(**不含 key 明文**),由上层按既有降级策略处理

#### Scenario: qwen-asr 已登记于注册表且可配置解析

- **WHEN** 读取已注册 STT kinds,并以 `CHAT_A_STT_KIND=qwen-asr` + `CHAT_A_DASHSCOPE_API_KEY` 调 `loadSttConfig`
- **THEN** kinds 列表含 `'qwen-asr'`;`loadSttConfig` 返回 `kind:'qwen-asr'` 配置(model/baseURL 内置默认,apiKey 回落 `CHAT_A_DASHSCOPE_API_KEY`),且既有 `kind=qwen` 便捷档解析保持不变
