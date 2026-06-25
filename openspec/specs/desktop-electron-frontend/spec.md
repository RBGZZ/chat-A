# desktop-electron-frontend Specification

## Purpose
TBD - created by archiving change desktop-electron-frontend. Update Purpose after archive.
## Requirements
### Requirement: 共享会话装配 `assembleApp()`(抽取复用,cli 行为不变)

系统 SHALL 在 `@chat-a/client` 提供 `assembleApp()`,把"加载 `.env.local` + LLM provider + LightVoiceBus + memory + persona + Conversation 工厂 + 幂等收尾"的**核心装配**封装成**无交互副作用**(不依赖 readline/stdout)的可复用单元,返回含 `bus`/`convo`/`makeConvo`/`reset`/`persona`/`composeOmniInstructions`/`cleanup`/`env` 等的 `AppHandle`。该抽取 MUST 为**重构**而非重写:`cli.ts` 改为调用 `assembleApp()` 后,其启动横幅、状态行、斜杠命令、语音模式、退出收尾行为 MUST 逐字不变,既有 client 测试(`commands`/`env-file`/`cli-voice-wiring`/`assembly-*`)MUST 全绿。`assembleApp()` MUST 只经既有公开 API 装配,MUST NOT 改 runtime/providers/memory/persona 内部。`cleanup()` MUST 幂等(多次调用只收尾一次、不抛)。

#### Scenario: FakeLLM 下装配并完成一个文字回合

- **WHEN** 在 `CHAT_A_LLM_PROVIDER=fake`(或无任何 key)下调用 `assembleApp()`,再 `convo.send('你好', onToken)`
- **THEN** `onToken` 收到若干流式 token,`send` resolve 出非空回复字符串(FakeLLM 占位),全程不触网

#### Scenario: reset 换会话、cleanup 幂等

- **WHEN** 调用 `app.reset()`
- **THEN** `app.sessionId` 变为新值、`app.convo` 为基于新 sessionId 重建的实例(长期记忆仍保留)
- **WHEN** 连续多次调用 `app.cleanup()`
- **THEN** 只实际收尾一次(关库/trace 等),后续调用为 no-op、绝不抛

#### Scenario: cli 复用后行为不变

- **WHEN** `cli.ts` 改为基于 `assembleApp()` 装配后运行既有 client 测试套件
- **THEN** `commands`/`env-file`/`cli-voice-wiring`/`assembly-*` 等既有测试全部通过(抽取重构不改变行为)

### Requirement: Electron 主进程 in-process 复用装配并经 IPC 暴露会话

系统 SHALL 提供 `packages/desktop` Electron 主进程,在**同一进程内**复用 `assembleApp()` 装大脑(Conversation + 记忆 + 人格 + provider),MUST NOT 起独立大脑进程或 WS 网关(等价单机 CLI 形态,§2)。主进程 SHALL 经类型化 IPC 契约暴露:渲染→主的 `chat:send`/`voice:start`/`voice:stop`/`session:reset`/`app:get-info`;主→渲染推送的 `chat:token`(逐 token 流式)/`chat:reply`(完整回复)/`chat:error`(降级文案)/`state:change`/`mood:change`/`voice:transcript`。`chat:send` 的回合编排 SHALL 把 `convo.send` 的 token 逐个经 `chat:token` 推送、resolve 后经 `chat:reply` 推完整回复;回合抛错时 MUST 经 `chat:error` 推友好中文降级文案且主进程 MUST NOT 崩(§3.2)。IPC channel 名与映射纯逻辑 SHALL 抽成不依赖 electron 的可单测模块。

#### Scenario: chat:send 流式回 token 与最终回复

- **WHEN** 以假 `send`(吐若干 token 后 resolve 出 reply)调用回合编排纯函数 `runSendTurn`
- **THEN** 依次 emit 出每个 `chat:token`(顺序与 send 一致),随后 emit 一次 `chat:reply`(完整回复);不 emit `chat:error`

#### Scenario: 回合出错降级不崩

- **WHEN** 假 `send` 抛错,调用 `runSendTurn`
- **THEN** emit 一次 `chat:error`(友好中文文案),不 emit `chat:reply`,且 `runSendTurn` 不向上抛(主进程绝不崩)

#### Scenario: 总线事件派生 UI 状态

- **WHEN** 向 `StateTracker` 依次喂 `turn:start`、`tts:first_audio`、`turn:end`
- **THEN** UI state 依次为 `thinking`、`speaking`、`idle`,每次变化触发 `onChange`
- **WHEN** 喂 `vad:speech_start`
- **THEN** UI state 为 `listening`

#### Scenario: 回合后心情摘要

- **WHEN** 以 `persona.tone()` 的结果调用 `toMoodSummary`
- **THEN** 得到含 `emotion` 与 PAD(pleasure/arousal/dominance)的摘要,供状态栏展示

### Requirement: preload 安全桥(contextIsolation,无 nodeIntegration)

系统 SHALL 用 preload + `contextBridge.exposeInMainWorld` 暴露**白名单最小** IPC API(`send`/`voiceStart`/`voiceStop`/`reset`/`getInfo` + `on*` 订阅器),`BrowserWindow` MUST 配置 `contextIsolation:true`、`nodeIntegration:false`。preload MUST NOT 向渲染层泄漏 `ipcRenderer` 本体或任何 node 能力;`on*` 订阅器 SHALL 返回退订函数,且只经 `IPC` 常量定义的 channel 收发。

#### Scenario: 渲染层只能访问白名单 API

- **WHEN** 渲染层运行
- **THEN** `window.xiaoxue` 仅含白名单方法(send/voiceStart/voiceStop/reset/getInfo/on*),无 `require`/`ipcRenderer`/node 全局(`contextIsolation` 生效)

### Requirement: 语音原生音频路结构就位 + naudiodon 优雅降级

系统 SHALL 在 `voice:start` 时复用既有 `startVoiceMode`(`NodeAudioDevice` + `VoiceLoop`,云端 STT/TTS 或 omni 直路,不引本地模型)跑免提语音。主进程 SHALL 在进入 `startVoiceMode` 前**显式探测** naudiodon 可用性:可用 → 启动并经 `voice:status{available:true,path,device}` 通知渲染层;**不可用(未装/未 rebuild,`init()` 抛错)→ 经 `voice:status{available:false,reason}`(中文原因)通知,且 MUST NOT 影响文字路、主进程 MUST NOT 崩**(§3.2)。渲染层收到 `available:false` SHALL 禁用语音按钮并提示原因;文字对话在语音不可用时 MUST 照常工作。

#### Scenario: naudiodon 不可用时优雅降级

- **WHEN** 以一个 `init()` 抛错的假设备调用 `probeVoice`
- **THEN** 返回 `{ available:false, reason:'语音需安装原生音频(见 README)' }`,不抛;文字路不受影响

#### Scenario: naudiodon 可用时探测通过

- **WHEN** 以一个 `init()` 正常 resolve 的假设备调用 `probeVoice`
- **THEN** 返回 `{ available:true }`(随后主进程进入 `startVoiceMode` 跑语音闭环)

### Requirement: 纯 HTML/CSS/TS 渲染层(不引重框架)

系统 SHALL 提供纯 HTML/CSS/TypeScript 渲染层(esbuild 打包,MUST NOT 引入 React/Vue 等重框架),含:用户/小雪消息气泡、输入框 + 发送、流式 token 追加、语音开关按钮、状态栏(当前 state + 小雪心情摘要),中文界面。渲染层 SHALL 经 `window.xiaoxue` 订阅 `chat:token`/`chat:reply`/`state:change`/`mood:change`/`voice:status`/`voice:transcript` 并相应更新 UI。

#### Scenario: 流式 token 追加进小雪气泡

- **WHEN** 渲染层发送一条消息后陆续收到 `chat:token`
- **THEN** 这些 token 依次追加进当前"小雪"气泡;收到 `chat:reply` 后该气泡定型

### Requirement: 构建/运行脚本与中文安装文档

系统 SHALL 在根 `package.json` 提供 `desktop:dev`(启动 Electron)、`desktop:rebuild`(`electron-rebuild` 重编 naudiodon)、`desktop:build`(electron-builder 打包占位)脚本,并在 `packages/desktop` 提供中文 README/quickstart:前置(VS Build Tools「C++ 桌面开发」工作负载用于编 naudiodon)、步骤(`pnpm install` → `pnpm desktop:rebuild` → `pnpm desktop:dev`)、最简可用条件(只填 `.env.local` 的 `CHAT_A_DASHSCOPE_API_KEY` 即文字可用,语音需先 rebuild naudiodon)。

#### Scenario: 文档给出最简文字可用路径

- **WHEN** 用户只在项目根 `.env.local` 填 `CHAT_A_DASHSCOPE_API_KEY` 并按 README 跑 `pnpm desktop:dev`
- **THEN** 文档指引其可立即用文字对话(语音作为可选项,需额外 `pnpm desktop:rebuild`)

### Requirement: desktop 经 CosyVoice 管线一键复刻本地音频

当选用 CosyVoice 引擎时,desktop 复刻入口 SHALL 在"选本地文件"前提下完成:读盘 → DashScope 临时上传取得 `oss://` URL → CosyVoice `create_voice` → 异步轮询直到 `OK`。引擎选择 SHALL 经配置(如 `CHAT_A_VOICE_CLONE_KIND=cosyvoice` 或 target_model 含 `cosyvoice`)决定;未选 CosyVoice 时复刻走现有 qwen 链路、行为不变。

#### Scenario: 本地文件 CosyVoice 复刻成功
- **WHEN** 用户在 CosyVoice 引擎下选择本地音频并触发复刻,上传/创建/轮询均成功
- **THEN** desktop 取得可用 voice_id,渲染层显示复刻成功

#### Scenario: 复刻任一步失败优雅降级
- **WHEN** 上传、创建或轮询任一步失败
- **THEN** desktop 显示清晰中文失败原因、不崩溃,文字对话功能不受影响

### Requirement: desktop 复刻成功持久化 CosyVoice 合成配置

CosyVoice 复刻成功后,desktop SHALL 把 `voice_id`、`target_model`(=合成所用 `cosyvoice-v3.5-flash`)、`CHAT_A_TTS_KIND=cosyvoice` 持久化到 `.env.local` 并即时设入进程 env,使复刻成功即可直接以复刻音色朗读、无需手动配模型。持久化 SHALL 同键幂等覆盖。

#### Scenario: 持久化后直接可朗读
- **WHEN** CosyVoice 复刻成功
- **THEN** `.env.local` 含一致的 voice_id + target_model + CHAT_A_TTS_KIND=cosyvoice,后续朗读以复刻音色合成

#### Scenario: 合成 model 与复刻 target_model 同串
- **WHEN** 持久化复刻结果
- **THEN** 写入的合成 model 与复刻 target_model 逐字一致(满足 CosyVoice 一致性硬约束)

### Requirement: 复刻轮询期进度反馈

CosyVoice 复刻含异步轮询(可达数分钟);desktop SHALL 在轮询期向渲染层报告进行中状态,避免用户误以为卡死。

#### Scenario: 轮询期显示进行中
- **WHEN** 复刻处于异步部署轮询阶段
- **THEN** 渲染层显示"复刻处理中"一类进度状态,直至成功或失败

### Requirement: desktop 朗读按当前心情注入情绪指令

当 `CHAT_A_TTS_EMOTION_FROM_MOOD` 启用时,desktop 朗读路径 SHALL 在合成每条回复前读取小雪当前心情(`persona.tone()` 的 PAD / voiceInstruction),计算情绪指令并作 `TtsOptions.instruction` 逐句注入,使复刻音色随心情说话。开关 SHALL **默认关闭**;关闭时朗读沿用静态 `CHAT_A_TTS_INSTRUCTION`(或无),逐字回归。

#### Scenario: 启用时朗读带当前心情
- **WHEN** 开关启用,某条回复合成时小雪处于某情绪态
- **THEN** 该回复以对应情绪指令朗读(复刻音色随情绪变化)

#### Scenario: 关闭时不变
- **WHEN** 开关未启用
- **THEN** 朗读不注入心情指令,行为与本能力引入前一致

#### Scenario: 心情读取失败优雅降级
- **WHEN** 启用但读取心情/计算指令出错
- **THEN** 朗读回落到无心情指令(静态或无),不崩、不中断朗读

