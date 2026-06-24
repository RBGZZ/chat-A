## 1. WAV 编解码工具 + WAV 文件音频设备(client,零原生依赖)

- [x] 1.1 新增 WAV 编/解码纯函数(`packages/client/src/audio/wav.ts`):`decodeWav(bytes) → { samples: Int16Array, sampleRate, channels }`(解析 RIFF/WAVE,断言 PCM s16le;非 16k/mono 明确报错)+ `encodeWav(samples, sampleRate, channels) → Uint8Array`(复用 openai-compat-stt 的 RIFF 写法思路,client 侧独立一份,不跨包 import provider 私有函数)
- [x] 1.2 新增 `WavFileAudioDevice`(`packages/client/src/audio/wav-file-audio-device.ts`)实现 `AudioDevice`:构造吃 `{ inputWavPath? | inputFrames?, outputWavPath?, schedule?, now? }`;`captureStart` 把帧序列(从 WAV 切 160 样本/帧或直接用注入帧)异步逐帧回调,`timestampMs` 按 10ms 步进;`close` 后停
- [x] 1.3 `play(chunk)` 累积 Int16 到内存缓冲(记 sampleRate);`close`/`flush` 时编码成 WAV 写 `outputWavPath`(省略则只留内存缓冲供断言);`playStop` 记停止次数;全程 close 后 no-op
- [x] 1.4 `id='wav'`;暴露内存缓冲/播放停止计数等只读字段供测试断言

## 2. 无模型 VAD + 静音超时 EOU(voice-detect)

- [x] 2.1 config.ts 加 `EnergyVadConfig`(`rmsThreshold` 等)+ `DEFAULT_ENERGY_VAD_CONFIG`;加 `SilenceEouConfig`(`silenceTimeoutMs` / 低能量阈值 / 帧时长)+ `DEFAULT_SILENCE_EOU_CONFIG`(无 magic number)
- [x] 2.2 新增 `EnergyVadDetector`(`packages/voice-detect/src/energy-vad.ts`)实现 `VadDetector`:逐帧算 RMS → 归一化 0~1 → 喂既有 `VadGate`;`reset` 清状态。无 ONNX/模型/原生依赖
- [x] 2.3 新增 `SilenceTimeoutEouModel`(`packages/voice-detect/src/silence-eou.ts`)实现 `EouModel`:据窗尾连续低能量帧累积时长 ≥ `silenceTimeoutMs` → 高 eouProb,否则低;`reset` 清状态
- [x] 2.4 `index.ts` 导出 `energy-vad` / `silence-eou`

## 3. 云 STT「填 key 即用」(providers,纯加法)

- [x] 3.1 `stt-config.ts`:`loadSttConfig` 加 `CHAT_A_STT_KIND=qwen` 便捷档 → 产出 `openai-compat` 配置(`model` 缺省 `qwen3-asr-flash`、`baseURL` 缺省 DashScope `…/compatible-mode/v1`、`apiKey` 回落 `CHAT_A_DASHSCOPE_API_KEY`、`id='qwen-asr'`);`CHAT_A_STT_MODEL`/`CHAT_A_STT_BASE_URL` 可覆盖
- [x] 3.2 确认缺省(无 key 且未显式配 STT)仍回落 `fake`(回归不破);新增 DashScope 兼容端点常量复用既有 `QWEN_DASHSCOPE_BASE_URL`(或在 stt-config 具名常量,无 magic number)

## 4. cli 装配加档(client,纯加法,缺省不变)

- [x] 4.1 `cli-voice.ts` `createAudioDevice`:加 `wav` 档 → 构造 `WavFileAudioDevice`(读 `CHAT_A_AUDIO_IN_WAV`/`CHAT_A_AUDIO_OUT_WAV`);缺省仍 `fake`
- [x] 4.2 `cli-voice.ts` `createDetectors`:加 `energy` 档 → `EnergyVadDetector` + `SilenceTimeoutEouModel`;构造失败明确提示并回落桩(沿用既有范式);缺省仍 `stub`
- [x] 4.3 状态行/info 反映实际 device/vad/eou 标识(回落后真实值)

## 5. 一键命令 + 中文 quickstart(根)

- [x] 5.1 新增 `scripts/voice-text-to-wav.ts`:加载 `.env.local` → 用 `qwen` LLM 生成一句回复 → 用 `qwen-tts` 合成 → 经 WAV 编码落 `out.wav`;无 DashScope key 时明确提示需填 key(100% key-only 路径 A)
- [x] 5.2 根 `package.json` 加 `"test:voice": "tsx scripts/voice-text-to-wav.ts"`(不进 CI,需真 key)
- [x] 5.3 README 增中文 quickstart 段:一句「把 key 填进 `.env.local` 的 `CHAT_A_DASHSCOPE_API_KEY`,跑 `pnpm test:voice`」+ 涉及 env 开关默认值表 + 标注「全语音待云 STT 真网络确认」「真麦克风仍需 naudiodon」

## 6. Qwen WS 连通性 smoke 脚本(真网络,默认不进 CI)

- [x] 6.1 新增 `scripts/qwen-smoke.ts`:有 `CHAT_A_DASHSCOPE_API_KEY` → 真连 `qwen-tts`(真 WS,合成一句存 WAV);无 key → 打印中文「跳过(需真网络+key)」并 exit 0;绝不打印 key
- [x] 6.2 脚本头注释标注「需真网络、手动跑、默认不进 CI」;(可选)`package.json` 加 `smoke:qwen` 脚本

## 7. 测试(全 Fake/注入、不触网、不碰真硬件)

- [x] 7.1 WAV 编解码往返:`encodeWav`→`decodeWav` 还原样本/采样率;非 16k/mono 头部 → 报错
- [x] 7.2 `WavFileAudioDevice`:注入 `PcmFrame[]` + 注入 schedule → 采集逐帧回调(timestamp 步进);`play` 累积 → `close` 产出 WAV 可解码还原;close 后 no-op
- [x] 7.3 `EnergyVadDetector`:高/低能量帧序列 → RMS 概率 + speech_start/end 事件(VadGate 去抖)
- [x] 7.4 `SilenceTimeoutEouModel`:窗尾静音达阈 → 高 eouProb;有声 → 低
- [x] 7.5 `loadSttConfig`:`CHAT_A_STT_KIND=qwen` + DashScope key → 正确 openai-compat 档(model/baseURL/key 回落);`CHAT_A_STT_MODEL`/`BASE_URL` 覆盖生效;无 key 缺省 → fake(回归)
- [x] 7.6 开关默认值回归:`CHAT_A_AUDIO_DEVICE` 缺省 → fake;`CHAT_A_VAD` 缺省 → stub(`createDetectors`/`createAudioDevice` 纯函数断言)

## 8. 验证

- [x] 8.1 `pnpm -r typecheck` 全绿(新增 + 回归)
- [x] 8.2 `npx vitest run` 全绿(新增 + 既有回归)
- [x] 8.3 `npx openspec validate key-only-test-harness --strict` 通过
