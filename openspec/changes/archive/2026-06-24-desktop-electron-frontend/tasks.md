## 1. 抽取共享装配 `assembleApp()`(`packages/client/src/assembly/app.ts`,最小重构,保 cli 行为不变)

- [x] 1.1 新建 `assembly/app.ts`,导出 `assembleApp(opts?: { env?; argv? }): AppHandle`——把 cli.ts `main()` 里的核心装配(`loadEnvLocal` → `loadLlmConfig`/`createLlm` → `LightVoiceBus` → `createMemoryStoreFromEnv` → `loadPersonaFromEnv`+`seedPersonaMemories`+`createKvPersonaStore` → `PersonaEngine` → `makeConvo`/`convo` 工厂 → telemetry → cleanup)原样搬入(逻辑不动)
- [x] 1.2 `AppHandle` 暴露 desktop+cli 共用核心:`bus`、`llmConfig`、`memoryInfo`、`seed`、`persona`、可变 `convo`/`sessionId`、`makeConvo`、`reset()`、`composeOmniInstructions`、`cleanup()`(幂等)、`env`
- [x] 1.3 `cleanup()` 幂等(`cleaned` 闸)+ 全程降级(关库/trace/telemetry 失败吞);`reset()` = 换 sessionId + `convo = makeConvo(sid)`(供 desktop/cli 共用)
- [x] 1.4 `cli.ts` 改为调用 `assembleApp()`:横幅/状态行/`/reset`/语音/autonomy/感知/巩固/readline **留在 cli.ts**(它们要 stdout 交互),改读 `app.bus`/`app.convo`/`app.persona`/`app.reset`/`app.cleanup` 等;**确认 cli 启动横幅、状态行、命令、语音、退出收尾逐字等价**
- [x] 1.5 `@chat-a/client` 导出 `assembleApp`/`AppHandle`(+ 既有 `parseDotEnv`/`applyDotEnv`/`startVoiceMode`/`NodeAudioDevice` 公开供 desktop import);确认既有 `commands.test`/`env-file.test`/`cli-voice-wiring.test`/`assembly-*.test` 全绿(抽取不破坏)

## 2. 新建 `packages/desktop` 包骨架(纳入 pnpm workspace)

- [x] 2.1 `packages/desktop/package.json`:`name=@chat-a/desktop`、`private`、`type` 适配(main CJS / 渲染 esbuild);dependency `@chat-a/client`(workspace:*)+ `@chat-a/runtime` + `@chat-a/providers` + `@chat-a/persona` + `electron` + `naudiodon`;devDep `electron-rebuild`/`esbuild`/`@types/node`;`typecheck` 脚本
- [x] 2.2 `packages/desktop/tsconfig.json`(extends base;含 main/preload/renderer/ipc-contract)
- [x] 2.3 确认 `pnpm-workspace.yaml` 的 `packages/*` 已涵盖(无需改);`packages/desktop` 被 workspace 识别

## 3. IPC 契约 + 映射纯逻辑(`packages/desktop/src/ipc-contract.ts`,不 import electron,可单测)

- [x] 3.1 `IPC` channel 常量(单一真相源)+ 类型(`UiState`/`MoodSummary`/`VoiceStatus`/`AppInfo`/消息 payload)
- [x] 3.2 `deriveState(prev, event): UiState` 纯函数 + `StateTracker`(持当前态、订阅 LightVoiceBus,把 `turn:start→thinking`/`tts:first_audio→speaking`/`turn:end→idle`/`vad:speech_start→listening`/`vad:speech_end→thinking` 归约);`StateTracker.onChange(cb)`
- [x] 3.3 `toMoodSummary(tone): MoodSummary` 纯函数(从 `persona.tone()` 的 `{emotion,pad}` 取摘要)
- [x] 3.4 `runSendTurn({ send, emit }, text): Promise<void>` 纯编排:`send(text, onToken→emit token)` → resolve `emit reply` → catch `emit error`(友好中文文案,不抛,§3.2)
- [x] 3.5 `probeVoice(makeDevice): Promise<VoiceStatus>` 纯探测:`await device.init()` 成功 → `{available:true}`;抛错 → `{available:false, reason:'语音需安装原生音频(见 README)'}`(不抛)

## 4. Electron 主进程(`packages/desktop/src/main.ts`)

- [x] 4.1 启动:`loadEnvLocal`(复用 client `parseDotEnv`/`applyDotEnv` 读项目根 `.env.local`)→ `assembleApp()` 装大脑(in-process,复用既有装配,接 qwen)
- [x] 4.2 `BrowserWindow`:`contextIsolation:true`、`nodeIntegration:false`、`sandbox:true`、`preload` 指向打包后的 preload;加载 `index.html`
- [x] 4.3 IPC handler(渲染→主):`ipcMain.handle(IPC.send, (_e, text) => runSendTurn({ send: app.convo.send, emit: (ch,p)=>win.webContents.send(ch,p) }, text))`;`IPC.reset`→`app.reset()`;`IPC.getInfo`→返回 `AppInfo`(从 `app.llmConfig`/`memoryInfo`/`seed`);`IPC.voiceStart`/`IPC.voiceStop`(见 §5)
- [x] 4.4 订阅 `app.bus`:`StateTracker` → 变化推 `state:change`;`turn:end` 后读 `app.persona.tone()` → 推 `mood:change`;`stt:final` → 推 `voice:transcript`;启动后推一次初始 state/mood
- [x] 4.5 窗口关闭/`before-quit` → `await app.cleanup()`(幂等收尾);全程 try/catch,主进程绝不崩

## 5. 语音路接入 + naudiodon 优雅降级(`main.ts`,§4/§3.2)

- [x] 5.1 `IPC.voiceStart`:先 `probeVoice(() => new NodeAudioDevice())` 显式探测 naudiodon;失败 → 推 `voice:status{available:false,reason}`,**不进** `startVoiceMode`、文字路不受影响
- [x] 5.2 探测成功 → 设 `env.CHAT_A_AUDIO_DEVICE='node'`(未显式设时)→ 调既有 `startVoiceMode({ send:(t,cb)=>app.convo.send(t,cb), composeOmniInstructions: app.composeOmniInstructions, memory, bus: app.bus, sessionId: app.sessionId, env })` → 推 `voice:status{available:true, path, device}`;持 `voiceHandle`
- [x] 5.3 `IPC.voiceStop`:`voiceHandle?.stop()`(幂等);全程 try/catch,失败推 `voice:status{available:false,reason}` 不崩
- [x] 5.4 语音走云(默认 STT/TTS 或 `CHAT_A_VOICE_PATH=omni`),不引本地模型;复用既有 `startVoiceMode` 内 STT/TTS/VAD/Omni 装配(零改 cli-voice)

## 6. preload 安全桥(`packages/desktop/src/preload.ts`)

- [x] 6.1 `contextBridge.exposeInMainWorld('xiaoxue', api)`:`send`/`voiceStart`/`voiceStop`/`reset`/`getInfo` 经 `ipcRenderer.invoke`;`onToken`/`onReply`/`onError`/`onState`/`onMood`/`onTranscript`/`onVoiceStatus` 经 `ipcRenderer.on` 包装(返回退订函数,不泄漏 `ipcRenderer` 本体)
- [x] 6.2 全程只用 `ipcRenderer` 白名单 channel(对齐 `IPC` 常量);`contextIsolation` 下不暴露 node 能力

## 7. 渲染层(纯 HTML/CSS/TS,esbuild,`packages/desktop/src/renderer/`)

- [x] 7.1 `index.html`:聊天区 + 输入行(输入框 + 发送)+ 顶栏(state + 心情)+ 语音开关按钮;中文界面
- [x] 7.2 `renderer.ts`:订阅 `window.xiaoxue.on*`——发送建用户气泡 + 占位小雪气泡;`onToken` 追加到当前小雪气泡;`onReply` 收尾;`onState`/`onMood` 更新状态栏;`onVoiceStatus` 控制语音按钮(`available:false`→禁用+tooltip reason)
- [x] 7.3 `styles.css`:简洁中文 UI(气泡左右分、状态栏、语音按钮态);esbuild 把 `renderer.ts`→`renderer.js`(IIFE)
- [x] 7.4 启动调 `getInfo()` 渲染横幅(人格名/模型/记忆);fake provider 时提示填 key

## 8. 脚本 + 文档

- [x] 8.1 根 `package.json` 加 `desktop:dev`(esbuild 打 main/preload → `electron packages/desktop`)、`desktop:rebuild`(`electron-rebuild -f -w naudiodon`)、`desktop:build`(electron-builder 占位)
- [x] 8.2 `packages/desktop/README.md`(中文 quickstart):前置=VS Build Tools「C++ 桌面开发」工作负载(编 naudiodon)、Python 已有;步骤=`pnpm install`→`pnpm desktop:rebuild`→`pnpm desktop:dev`;只填 `.env.local` 的 `CHAT_A_DASHSCOPE_API_KEY` 即文字可用;语音需 rebuild naudiodon

## 9. 测试(Fake/假总线,不触网、不碰 electron、不碰真音频)

- [x] 9.1 `assembleApp()` 单测:`CHAT_A_LLM_PROVIDER=fake` → `convo.send('你好', onToken)` 收到流式 token + 非空 reply;`reset()` 换 sessionId;`cleanup()` 幂等(多次调不抛)
- [x] 9.2 `deriveState`/`StateTracker` 单测:喂总线事件序列(turn:start/tts:first_audio/turn:end/vad:*)→ 断言 UI 四态迁移 + `onChange` 触发
- [x] 9.3 `toMoodSummary` 单测:给定 tone → 摘要字段正确
- [x] 9.4 `runSendTurn` 单测:假 send 吐 token+reply → emit 序列(token×N + reply);假 send 抛错 → emit error(友好文案)、不抛(§3.2)
- [x] 9.5 `probeVoice` 单测:init 抛错的假设备 → `{available:false, reason}`;init 成功 → `{available:true}`

## 10. 验证

- [x] 10.1 worktree 根 `pnpm -r typecheck` 全绿(含新 desktop 包 main/preload/renderer/ipc-contract;client 抽取不级联破坏)
- [x] 10.2 worktree 根 `npx vitest run` 全绿:新增 assembleApp/state/mood/send/probeVoice 测试通过 + **既有全量回归不破**(cli/cli-voice/assembly 抽取重构绿是硬线)
- [x] 10.3 尝试 `pnpm install`(装 electron + naudiodon):依赖**已装上**(electron@31 / esbuild / naudiodon optional 已 resolve),但**electron 二进制下载在本 headless 环境网络受限失败**(TLS 中断);结构/代码完整,用户本机 `pnpm install`(`allowBuilds.electron=true`)即会下载二进制。naudiodon/electron-rebuild 走 `pnpm dlx`,不污染锁文件的 exotic 子依赖
- [x] 10.4 自检与 canonical 一致:§2(in-process 装大脑,等价单机)、§4(复用 STT/Omni + AudioDevice 接缝)、§6(状态栏读 persona 心情)、§3.1(IPC 类型化接缝、只 import 公开 API)、§3.2(naudiodon 降级 + 会话出错降级,文字绝不崩);确认未改 runtime/providers/memory/persona/autonomy 内部,cli 行为逐字不变
