## Context

「小雪」北极星是**长期伴侣**,专属声音是陪伴感的关键(§4.1 音色复刻 v2.1)。现有 TTS 接缝(`TtsProvider` + `TtsCapabilities.voiceCloning` + `TtsOptions.voiceId/refAudio` + 能力门 `assertTtsCloning`)与配置(`tts-config`/`tts-registry`)早已就位;`qwen-tts-realtime` 已能用**内置音色**做 WS 流式合成,但 `voiceCloning=false`、不支持复刻。`voice-profile` 已能从 `CHAT_A_VOICE_ID` 解析 voiceId 并经装配层流到 `TtsOptions.voiceId`。Electron 桌面 app(主进程 in-process 复用 `assembleApp` + 类型化 IPC + preload 安全桥)文字路可用、语音路结构就位。

阿里云 DashScope **千问声音复刻**(`qwen-voice-enrollment` HTTP API)允许:上传一段 ~15s 参考音频 → 云端创建专属音色 → 返回 voice id → 实时合成 `qwen3-tts-vc-realtime` 直接用该 id。复用现有 `CHAT_A_DASHSCOPE_API_KEY`,无本地依赖,契合"瘦终端 + 云端大脑"。

### 核实到的 DashScope 千问声音复刻 API(以官方当时版本为准)

> ⚠️ **HTTP 契约抽成可改函数**:创建端点已较确定;**list / delete 的 action 动词与响应字段名官方公开文档未完整披露**,本切片按 CosyVoice 同族 `voice-enrollment` 推断实现并**标注为假设、真机不符改一处**。出处见文末。

- **创建音色端点**(POST,JSON):
  - 北京区 `https://dashscope.aliyuncs.com/api/v1/services/audio/tts/customization`
  - 新加坡区 `https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/customization`
  - Headers:`Authorization: Bearer $DASHSCOPE_API_KEY`、`Content-Type: application/json`
  - Body:
    ```json
    {
      "model": "qwen-voice-enrollment",
      "input": {
        "action": "create",
        "target_model": "qwen3-tts-vc-realtime-2026-01-15",
        "preferred_name": "xiaoxue",
        "audio": { "data": "data:audio/mpeg;base64,<BASE64>" }
      }
    }
    ```
  - **参考音频怎么传**:`input.audio.data` 接受 **base64 data URI**(`data:audio/<mime>;base64,...`)**或公网 URL**。✅ 选 **base64 data URI**——本地文件直接内联,**零操作**(不让用户填 URL / 传 OSS / 记 id)。
- **返回 voice id**:`output.voice`(字符串,如 `qwen-tts-vc-<name>-voice-<ts>-<hash>`)。
- **`target_model` 取值**(做成配置、**不写死快照**):实时优先 `qwen3-tts-vc-realtime`,快照如 `qwen3-tts-vc-realtime-2026-01-15` / `qwen3-tts-vc-realtime-2025-11-27`;非实时 `qwen3-tts-vc-2026-01-22`。**创建时的 target_model 必须与合成时模型一致**。
- **查询/列举/删除**(管理,**假设需真机校准**):同端点、`model: "qwen-voice-enrollment"`、`input.action` 取 `list` / `query` / `delete`;delete/query 带 `input.voice: "<voiceId>"`。响应字段名(list 的音色数组键)未公开确认,实现抽成可改解析函数。
- **合成时用 voice id**:实时——`qwen3-tts-vc-realtime` 经现有 WS,`session.update` 的 `voice` 字段直接放 voiceId(model 走 vc-realtime)。
- **音频要求**:格式 WAV(16bit)/ MP3 / M4A;时长推荐 10~20s、≤60s;大小 < 10MB;采样率 ≥ 24kHz;单声道;至少 3s 连续清晰朗读、无背景音。
- **鉴权**:`CHAT_A_DASHSCOPE_API_KEY`(**绝不打印**)。
- **配额/计费**:¥0.01/个音色,账号上限 1000 个,1 年未使用自动删除(以官方当时计费为准)。

出处:
- 阿里云「千问声音复刻 API 参考」 https://help.aliyun.com/zh/model-studio/qwen-tts-voice-cloning(及 alibabacloud.com 镜像)
- 「声音复刻用户指南」 https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide
- CosyVoice 复刻 API 参考(同族 voice-enrollment 管理动词推断) https://help.aliyun.com/zh/model-studio/developer-reference/cosyvoice-clone-api-reference
- DashScope Python SDK `VoiceEnrollmentService`(create/list_voice/query_voice/update_voice/delete) https://github.com/dashscope/dashscope-sdk-python
- 实测佐证 voiceId 形态:AstrBot issue #6045(复刻成功 id `qwen-tts-vc-hina_voice-voice-...`)https://github.com/AstrBotDevs/AstrBot/issues/6045

## Goals / Non-Goals

**Goals:**
- 后端复刻模块 `qwen-voice-clone.ts`:`createVoice(audio,opts)→{voiceId}`、`listVoices`、`deleteVoice`;fetch 可注入(单测 mock 不触网)、AbortSignal、失败抛清晰中文错(不含 key)。
- `qwen-tts-realtime` 配 vc 模型时 `voiceCloning=true`、`TtsOptions.voiceId` 当 WS `voice` 透传;**默认内置音色路径逐字不变**(回归硬线)。
- Electron 一键复刻:渲染层复刻区 + IPC `voice:clone(filePath)` + 主进程读文件→`createVoice`→持久化 `CHAT_A_VOICE_ID`→回流合成;无 key 禁用 + 中文提示;主进程绝不崩。
- HTTP 契约抽成可改函数,真机不符**改一处**。

**Non-Goals:**
- 非实时 HTTP 合成、app 内录音、多音色管理 UI、OSS 上传兜底、CosyVoice / 声音设计(见 proposal Non-goals)。
- 复刻不进首字延迟热路径(离线一次性操作)。

## Decisions

### D1:参考音频用 base64 data URI 内联,不走 OSS / URL
核实到 `input.audio.data` 接受 `data:audio/<mime>;base64,...`。**选 base64**:本地文件读字节 → 按扩展名推 MIME(.wav→audio/wav、.mp3→audio/mpeg、.m4a→audio/mp4)→ 编码 data URI。这让"用户给本地文件"零操作成立,无需公网可达。`createVoice` 同时接受 `Uint8Array`(+ mime)或本地路径(主进程读盘);`audioToDataUri` 抽成纯函数可单测。
- 备选:要求公网 URL(被否——逼用户传 OSS,违背"零复杂操作")。
- 大小护栏:编码前校验 < 10MB,超限抛中文错(提示压缩/截短),不浪费一次往返。

### D2:HTTP 契约抽成可改纯函数(`buildCreateBody`/`buildManageBody`/`parseVoiceId`/`parseVoiceList`)
创建端点较确定;list/delete 动词与响应字段名官方未完整公开。把"构造请求体""解析响应"抽成小函数,真机若不符**改一处**(§3.1 爆炸半径可控)。`createVoice` 解析 `output.voice`;解析不到抛中文错并附响应片段(便于真机定位)。

### D3:vc 能力位由配置驱动,默认 false(回归硬线)
`QwenTtsRealtimeConfig` 增 `voiceCloning?: boolean`(纯加法);`QwenTtsRealtime` 构造按它设 `capabilities.voiceCloning`(缺省 false)。**只有显式配 vc 模型 + `voiceCloning=true` 才进复刻路径**。合成时 `voice = opts.voiceId ?? this.#voice` 的现有逻辑已天然支持把复刻 voiceId 当 `voice` 透传——**realtime synthesize 主体几乎不改**,只放开能力位。`assertTtsCloning` 只在传 `refAudio` 时拦;复刻音色走 `voiceId`(已注册),不传 refAudio,故内置路径与默认行为零变化。
- 装配:`loadTtsConfig` 读 `CHAT_A_TTS_VOICE_CLONING=1` → `voiceCloning:true`;model 经 `CHAT_A_TTS_MODEL`(放 `qwen3-tts-vc-realtime`)。voiceId 经 `CHAT_A_VOICE_ID`(已有 `voice-profile` 链路)流到 `TtsOptions.voiceId`。

### D4:Electron 一键复刻 = IPC `voice:clone(filePath)` + 主进程薄壳 + 纯映射逻辑
镜像现有 IPC 架构:channel 常量进 `IPC`;**纯逻辑**(把 createVoice 结果映射成渲染层消息、错误降级)抽进 `ipc-contract.ts` 可 headless 单测的纯函数 `runCloneVoice(port, filePath)`;`main.ts` 只接 electron + 读文件 + 注入真 `createVoice` + 持久化。渲染层用浏览器原生 `<input type="file">` 拿到本地路径(Electron 渲染层 File 有 `.path`),经 preload `voiceClone(path)` 调用;无 path 兜底走 IPC 传字节。结果经 `voice:clone-result` 推回(成功 voiceId / 失败中文)。
- 持久化:主进程把 voiceId 写进项目根 `.env.local` 的 `CHAT_A_VOICE_ID`(`upsertEnvLocal` 纯函数:解析→改/插一行→写回,保留其它行)。同时即时设 `handle.env['CHAT_A_VOICE_ID']`,让本进程后续语音模式立即生效(无需重启)。
- 无 key:主进程探测 `CHAT_A_DASHSCOPE_API_KEY` 缺失 → 推 `{available:false, reason}`,渲染层禁用复刻区 + tooltip。

### D5:`createVoice` 入参形态
```ts
createVoice(audio: VoiceCloneAudio, opts: CreateVoiceOptions, signal?) → Promise<{ voiceId: string }>
// VoiceCloneAudio = { data: Uint8Array; mime: string } | { path: string }（path 仅 Node 侧）
// CreateVoiceOptions = { apiKey; targetModel; preferredName?; endpoint?; model?; fetch? }
```
fetch 注入端口复用 `FetchLike`(已在 gpt-sovits 定义,导出复用),不触网单测。

## Risks / Trade-offs

- **[list/delete 契约是假设]** → 抽成可改函数 + 显式注释"真机校准";`createVoice`(核心一键复刻)契约较确定,优先保它对。本期 list/delete 仅 API 就位 + 单测覆盖映射,不进关键 UX。
- **[Electron 渲染层 `File.path` 依赖]** → Electron 给 File 注入了 `.path`;若某版本不给,主进程 handler 同时支持收字节(渲染层 `arrayBuffer()`),双路兜底。
- **[base64 把请求体放大 ~33%]** → 10MB 音频 → ~13MB body;DashScope 接受(文档以原始 < 10MB 计)。编码前按原始字节校验 10MB 上限。
- **[写 .env.local 破坏用户文件]** → `upsertEnvLocal` 纯函数 + 单测覆盖(改既有键 / 插新键 / 保留注释与其它行 / 文件不存在则新建);失败吞但回传警告,不崩主进程。
- **[复刻配额/计费]** → 一键复刻每次产生新音色(¥0.01、上限 1000)。本期不做去重/复用;UI 文案提示"会创建一个新音色"。
- **[延迟]** → 复刻是离线一次性,不在首字延迟热路径(§3.2 无影响)。

## Migration Plan

纯加法,无数据迁移。默认不配置(无 `CHAT_A_TTS_VOICE_CLONING` / 非 vc 模型)时全链路逐字现状。回滚 = 还原文件;已写入 `.env.local` 的 `CHAT_A_VOICE_ID` 用户可手动删。

## Open Questions

- list/delete 的 `input.action` 精确动词(`list` vs `list_voice`)与 list 响应数组字段名——**真机校准**;已抽成可改函数。
- `qwen3-tts-vc-realtime` 的 WS `session.update` 是否对复刻 voiceId 有额外字段要求(AstrBot #6045 报过 "Invalid message type",疑似消息形态差异)——真机验证;现有 `buildAppend` 等已是可改函数,必要时改一处。
- 创建是否**异步**(返回任务 id 需轮询)还是同步直接返 voice——文档示例为同步直返 `output.voice`,按同步实现;真机若异步,在 `parseVoiceId` 处加轮询分支。
