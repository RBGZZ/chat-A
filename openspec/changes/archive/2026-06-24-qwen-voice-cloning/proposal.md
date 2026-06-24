## Why

「小雪」要做**长期伴侣**,而长期陪伴感的关键之一是**专属的声音**——同一把声音贯穿始终,最好还能是用户指定/亲近之人的声音。当前 TTS 只有 DashScope 内置音色(`qwen-tts-realtime` `voiceCloning=false`);GPT-SoVITS 虽支持 zero-shot 复刻但要本地 GPU,与"PC/树莓派 + 云端大脑"形态不匹配。

阿里云 DashScope 已上线**千问声音复刻**(`qwen-voice-enrollment`):用户给一段 ~15s 干净录音即可在云端创建专属音色、拿到 voice id,之后实时合成直接用——零本地依赖、复用现有 `CHAT_A_DASHSCOPE_API_KEY`。本切片把这条"一键复刻"链路打通,**零复杂操作**:桌面 app 选音频 → 一键 → 自动建音色、记住 voice id → 小雪从此用这把声音说话。

## What Changes

- **新增后端复刻模块**(`packages/providers`,新文件 `qwen-voice-clone.ts`):`createVoice(audio, opts) → { voiceId }`(吃本地音频字节/路径,按核实的 HTTP API 以 base64 data URI 上传)、`listVoices` / `deleteVoice`(管理/校验音色存活)。**fetch 可注入**(镜像 GptSoVitsTts 的 `FetchLike`,单测 mock 不触网)、支持 `AbortSignal`、失败抛清晰中文错误(**绝不打印 key**)。
- **`qwen-tts-realtime` 支持复刻音色合成**:当配置 vc 模型(`qwen3-tts-vc-realtime`)时声明 `voiceCloning=true`;`TtsOptions.voiceId` = 复刻 voice id 直接当 WS `session.update` 的 `voice` 用。**最小改动、不破坏内置音色路径**(默认仍 `voiceCloning=false`、内置音色,行为逐字不变)。
- **Electron 桌面前端加"复刻小雪声音"功能**:渲染层新增复刻区(选音频文件 → 一键复刻 → 进度/结果回显);新 IPC `voice:clone(filePath)` → 主进程读文件字节 → 调 `createVoice` → 拿 voiceId → **持久化**(写 `.env.local` 的 `CHAT_A_VOICE_ID`)→ 之后 TTS 自动用它。无 key → 该区禁用 + 中文提示;错误友好中文、**主进程绝不崩**。
- **配置/装配补线**:复刻得到的 voiceId 经现有 `voice-profile`(`CHAT_A_VOICE_ID`)/ `TtsOptions.voiceId` 流到合成;vc 模型 id 走配置(`CHAT_A_TTS_MODEL`),**不写死日期快照**。
- **`tts-config` / `tts-registry` 追加**:`QwenTtsRealtimeConfig` 增 `voiceCloning?` 声明位,工厂透传(纯加法)。

## Capabilities

### New Capabilities
- `voice-cloning`: 云端音色复刻能力——从一段参考音频创建专属音色(create)、查询/列举(list)、删除(delete);抽象出可注入 fetch 的 HTTP 契约 + 桌面端"一键复刻"交互 + voiceId 持久化与回流到合成。

### Modified Capabilities
- `tts-engine`: `qwen-tts-realtime` 在内置音色之外**新增复刻音色合成线缆**——配 vc 模型时 `voiceCloning=true`、`TtsOptions.voiceId` 当 `voice` 透传;默认不配置时既有内置音色路径**逐字不变**。

## Impact

- **canonical 章节/接缝**:§4.1(音色复刻 / 音色自定义 v2.1,长期伴侣的"专属声音")、§4.3(Provider 可换性 + 能力门 `voiceCloning`)、§3.2(优雅降级:无 key / 复刻失败均友好降级,主进程不崩;延迟预算无影响——复刻是**离线一次性**操作,不在首字延迟热路径上)、§3.1(模块化:复刻模块独立、HTTP 契约抽成可改函数,真机不符改一处)。
- **代码(本切片范围)**:`packages/providers/src/qwen-voice-clone.ts`(新)、`qwen-tts-realtime.ts`(VC 能力位 + voiceId 透传)、`tts-config.ts` / `tts-registry.ts`(`voiceCloning` 声明位透传)、`index.ts`(导出);`packages/desktop`(`ipc-contract.ts` 新 channel + 纯映射、`preload.ts`、`main.ts` handler、`renderer/{index.html,renderer.ts,api.ts,styles.css}` 复刻区)。必要时 `voice-profile`(已支持 `CHAT_A_VOICE_ID`,无需改)。protocol 不改。
- **依赖**:无新外部依赖(沿用 `globalThis.fetch` + Node `fs`)。
- **鉴权 / 配额**:复用 `CHAT_A_DASHSCOPE_API_KEY`;音色 ¥0.01/个、上限 1000、1 年未用删(以官方当时计费为准)。
- **真机待验**:HTTP 契约(创建端点 body / list·delete 的 action 动词与字段名)以 mock 实现并标注为**假设需真机校准**;真 key 真音频复刻 + Electron GUI 上传留待真机。

## Non-goals

- 非实时(HTTP 一次性合成 `qwen3-tts-vc`)路径——本期只接实时 `qwen3-tts-vc-realtime`(对齐现有 WS 合成)。
- 录音功能(app 内麦克风录制参考音频)——本期只支持选**已有本地音频文件**;录音留待后续。
- 多音色管理 UI(切换/重命名/列表面板)——本期一键复刻 + 单一 `CHAT_A_VOICE_ID`;list/delete 仅作为后端 API 就位 + 校验用。
- 真 OSS 上传兜底——核实到创建接口 `audio.data` 接受 base64 data URI,直接内联本地文件,**无需** OSS;若真机证实超大文件需 URL,再加兜底。
- CosyVoice 复刻 / 声音设计(voice design)——本期只 Qwen 声音复刻。
