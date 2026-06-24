## Why

目标用户现在想测「小雪」,卡点是**真音频 I/O 必须原生库**(naudiodon 需 MSVC 构建链)+ 真 VAD/EOU 需 ONNX 模型文件 + 真 STT/TTS 需本地引擎/模型。这让「填个 key 就能试」变成「先装一堆原生依赖 + 配本地模型」——对只想验证效果的用户太重。

但项目已经有几乎所有「云端 + 可注入」积木:`qwen-tts`(DashScope WS 流式 TTS,实测协议)、`qwen` 纯文本 LLM(实测通)、`OpenAiCompatStt`(POST `/audio/transcriptions` 上传 WAV)、`AudioDevice` 接缝(Fake 已可跑闭环)、`VadDetector`/`EouModel` 接口(桩可跑)。**缺的只是把这些接成「无原生依赖、无本地模型、填 key 即测」的一条路径**:

- 没有**不依赖硬件**的真音频设备实现——`FakeAudioDevice` 采集恒空、播放只记内存,既不能喂真音频也听不到结果。
- 没有**无模型 VAD/EOU**——真路径要 sherpa-onnx 模型,桩又只回放注入概率,detect 层做不到「零模型但对真音频有反应」。
- DashScope 云 STT(同一个 key 即可用 `qwen3-asr-flash` 走 OpenAI 兼容 `/audio/transcriptions`)还没在配置层接成「填 DashScope key 自动启用」。
- 没有**一键命令 + 中文 quickstart**把「填 key 即测」那条路径固化下来,也没有**真网络 smoke 脚本**帮用户确认 key/网络通。

## What Changes

- **WAV 文件音频设备**(新增,可选):`WavFileAudioDevice implements AudioDevice`——从 16k/mono/s16le WAV 读帧当「麦克风」,把 TTS 下行块累积写成 WAV 当「扬声器」。纯 `node:fs`,**零原生依赖**、可注入、可测。cli `CHAT_A_AUDIO_DEVICE=wav` 选用(缺省仍 `fake`,默认不变)。
- **无模型 VAD + 静音超时 EOU**(新增,可选):voice-detect 加**纯 JS 能量阈值 VAD**(`EnergyVadDetector`:逐帧 RMS 过阈,复用既有 `VadGate` 去抖,**无 ONNX**)+ **静音超时 EOU**(`SilenceTimeoutEouModel`:静音累积超阈即判「说完」,无模型)。cli `CHAT_A_VAD=energy` 选用(缺省仍 `stub`,默认不变)。
- **云端语音栈「填 key 即用」**(配置层纯加法):
  - STT:`loadSttConfig` 在 `CHAT_A_STT_KIND=qwen`(或检测到 DashScope key)时回落到 DashScope 的 OpenAI 兼容 `/audio/transcriptions`(`qwen3-asr-flash`,base URL `…/compatible-mode/v1`,key 回落 `CHAT_A_DASHSCOPE_API_KEY`)——复用既有 `OpenAiCompatStt`,**零新 provider**。
  - TTS = `qwen-tts`、LLM = `qwen`(均已实测,key 回落 `CHAT_A_DASHSCOPE_API_KEY`)。
- **一键命令 + 中文 quickstart**(新增脚本 + 文档):
  - 根 `package.json` 加 `test:voice` 脚本(`CHAT_A_TEST_VOICE` 预设档),跑通**100% key-only** 的「文本输入→云 LLM→云 TTS→WAV 文件」路径(跳过 STT/麦克风,绝对可跑)。
  - README 增中文 quickstart:**「把 key 填进 `.env.local` 的 `CHAT_A_DASHSCOPE_API_KEY`,跑 `pnpm test:voice`」**,列清涉及 env 开关默认值;并标注「全语音(WAV→STT→…)」为「云 STT 待真网络确认」。
- **Qwen WS 连通性 smoke 脚本**(新增,默认不进 CI):一个 `scripts/qwen-smoke.ts`,有真 key + 真网络时真连 `qwen-tts`(WS 握手 + 收 PCM)并存一段 WAV;无 key 时跳过并提示。**标注需真网络、手动跑**。

**硬线**:新增 device/VAD/EOU/STT 档**全部是可选项**,缺省配置(`CHAT_A_AUDIO_DEVICE=fake` / `CHAT_A_VAD=stub` / STT 无 key→`fake`)与现状**逐字一致**;既有全量单测不可破。单测全 Fake/注入、不触网、不碰真硬件;smoke 脚本除外(标注真网络、手动跑)。

## Capabilities

### New Capabilities
- `key-only-test-harness`: 「填 DashScope key 即测」的可跑路径——无原生依赖的 WAV 文件音频设备 + 无模型能量 VAD/静音超时 EOU + 云 STT/TTS/LLM 配置接好 + 一键命令 + 中文 quickstart + 真网络 smoke 脚本;**全部默认关、缺省行为逐字不变**,可测(Fake/注入、不触网)、可降级(任一档构造失败明确提示并回落,绝不崩)。

### Modified Capabilities
<!-- 不破坏任何既有 spec REQUIREMENT:所有新增档为可选、默认关;cli/STT/TTS/voice-detect 既有行为在缺省值下逐字不变。 -->

## Impact

- **影响 canonical 章节**:§3.2(行为即配置 + 优雅降级:新档默认关、失败回落)、§4.1/§4.3(STT/TTS Provider 可换性:云档经既有接缝接入)、§4(VAD/EOU 三层:新增无模型实现挂同一接口)。与权威设计一致。
- **代码**:`packages/client/src/audio/`(新增 `wav-file-audio-device.ts` + WAV 编解码工具)、`packages/client/src/cli-voice.ts`(device/VAD 工厂加档,纯加法)、`packages/voice-detect/src/`(新增 `energy-vad.ts` / `silence-eou.ts` + index 导出 + config 阈值)、`packages/providers/src/stt-config.ts`(qwen STT 档,纯加法)、根 `package.json`(`test:voice` 脚本)、`scripts/qwen-smoke.ts`、`README.md`(中文 quickstart)。**不碰** `packages/runtime` 的 voice-loop 内部、不碰 `packages/autonomy`、不碰 `packages/client/src/assembly/autonomy.ts`。
- **依赖**:仅用 Node 内置(`node:fs`)+ 既有 `ws`(qwen-tts 已用);**不引任何原生/重型新依赖**。
- **降级/默认**:WAV device/能量 VAD/静音 EOU/云 STT 档**全部默认关**;真档构造失败 → 明确中文提示并回落(沿用既有真设备/真 VAD 回落范式);缺省值下 cli/STT/TTS/voice-detect 行为逐字不变。
- **延迟预算**:WAV device 是文件 I/O(测试/离线用,非实时热路径);能量 VAD/静音 EOU 是 O(n) 纯算术,**对真链路首字延迟无新增**。
- **测试**:新增 WAV 编解码往返、WAV device 采集/播放、能量 VAD 概率/事件、静音 EOU 超时判定、qwen STT 配置解析的单测(Fake/注入、不触网、不碰真硬件);既有全量回归保持绿。
- **真机/真网络待验证(本 change 不验证)**:云 STT(`qwen3-asr-flash` 经 OpenAI 兼容端点的真实 multipart 上传往返)、`qwen-tts` 真 WS 握手与 PCM 回流——均交 smoke 脚本手动 + 真 key 验证;**真麦克风/扬声器仍需 naudiodon(原生,本 change 不解决)**。
