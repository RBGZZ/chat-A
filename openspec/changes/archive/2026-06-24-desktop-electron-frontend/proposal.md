## Why

chat-A 已有可用的**文字 CLI 前端**(`packages/client/src/cli.ts`)——in-process 装配 Conversation + 记忆 + 人格 + qwen provider +(可选)VoiceLoop,流式对话、斜杠命令、优雅降级都齐了。但 CLI 只面向开发者/终端用户;要让"小雪"像一位伴侣真正陪在桌面上,需要一个**图形前端**:能看见她的状态(在听/在想/在说)、心情,有消息气泡、输入框,以及一个**语音开关**。

本 change **不重写大脑**:Electron 主进程应**in-process 复用既有装配**(像 cli 那样 import 既有 packages),经 IPC 把"想/记/说"暴露给渲染层。交付 MVP:**文字路真能跑**(主进程接 qwen,渲染层发文字→看到流式回复),**语音路结构就位 + naudiodon 优雅降级**(装了原生音频且 rebuild 过 → 免提连续对话;没装 → 语音按钮禁用并提示,文字照常用、绝不崩)。

**硬线(回归绿是底线)**:只新增 `packages/desktop`,对既有 packages 只 import 公开 API;若需复用 cli 的装配,做**最小重构**——抽一个共享 `assembleApp()` 函数,cli 与 desktop 共用,**保 cli 行为逐字不变、既有测试全绿**。主进程会话装配 + IPC 消息映射逻辑**抽成可单测纯模块**,用 FakeLlm/假总线写**不触网单测**;Electron GUI 运行时与真音频**不单测**(标注真机待验)。

## What Changes

- **新增 `packages/desktop`(Electron app,纳入 pnpm workspace)**:
  - **主进程(main)**:加载 `.env.local`(复用 `@chat-a/client` 的 `parseDotEnv`/`applyDotEnv`)→ in-process 装配一个会话(复用抽取出的 `assembleApp()`:Conversation + memory + persona + qwen provider + 共享 LightVoiceBus)→ 创建 `BrowserWindow`(`contextIsolation:true`、`nodeIntegration:false`、`sandbox` 友好)→ 注册 IPC handler,把"想/记/说"暴露给渲染层。
  - **preload**:`contextBridge.exposeInMainWorld('xiaoxue', api)`,只暴露**安全最小**的 IPC API(`send`/`onToken`/`onReply`/`onState`/`onMood`/`onTranscript`/`voiceStart`/`voiceStop`/`reset`/`getInfo`)。
  - **渲染层(renderer)**:**纯 HTML/CSS/TS,不引重框架**(esbuild 打渲染包)。聊天 UI:用户/小雪消息气泡、输入框 + 发送、流式 token 追加;**语音开关按钮**(naudiodon 不可用时禁用 + 提示);**状态栏**(当前 state:idle/listening/thinking/speaking + 小雪心情摘要)。中文界面、简洁好看。
- **抽取共享装配 `assembleApp()`(`packages/client/src/assembly/app.ts`,最小重构)**:把 cli.ts 里"env 加载 + llm + bus + memory + persona + Conversation 工厂 + 收尾 cleanup"的**核心装配**抽成一个**纯函数式**(无 readline/无 stdout 交互)的可复用模块,返回 `{ convo, bus, makeConvo, persona, info, cleanup, ... }`。cli.ts 改为调用它(行为逐字不变);desktop 主进程也调用它。
- **IPC 接口(主进程 ↔ 渲染层)** + **消息映射逻辑抽成纯模块**(`packages/desktop/src/ipc-contract.ts` + 主进程薄壳):
  - 渲染→主:`chat:send(text)`(流式回 token,最终回 reply)、`voice:start`、`voice:stop`、`session:reset`、`app:get-info`。
  - 主→渲染(推送):`chat:token`(流式 token)、`chat:reply`(本回合完整回复)、`chat:error`(降级文案)、`state:change`(idle/listening/thinking/speaking,由订阅 LightVoiceBus 的 `turn:start`/`turn:end`/`vad:*`/`tts:first_audio` 派生)、`mood:change`(情绪/PAD 摘要,回合后读 persona)、`voice:transcript`(`stt:final`)。
- **语音(原生音频)路结构就位 + 优雅降级**:`voice:start` 时主进程用既有 `startVoiceMode`(`@chat-a/client` 的 `NodeAudioDevice` + `VoiceLoop`)跑免提;`CHAT_A_AUDIO_DEVICE=node`。**naudiodon 不可用(未装/未 rebuild)→ `device.init()` 抛错被 catch → IPC 回 `voice:unavailable` + 中文原因**,渲染层禁用语音按钮并提示"语音需安装原生音频(见 README)";文字照常用、主进程绝不崩。语音走云(默认 STT/TTS 或 `CHAT_A_VOICE_PATH=omni`),不需要本地模型。
- **脚本 + 文档**:根 `package.json` 加 `desktop:dev`(electron 启动)、`desktop:rebuild`(electron-rebuild 重编 naudiodon)、`desktop:build`(electron-builder 打包占位);`packages/desktop` 写中文 README/quickstart(前置=VS Build Tools「C++ 桌面开发」工作负载;步骤=`pnpm install`→`pnpm desktop:rebuild`→`pnpm desktop:dev`;只填 key 即文字可用)。
- **依赖**:`electron` + `naudiodon`(可选,运行时动态 import,作 desktop 包 dependency)+ `electron-rebuild`/`esbuild`(devDep)。

## Non-goals

- **不重写大脑 / runtime / 既有 packages 内部**:Conversation/VoiceLoop/memory/persona/providers 只经**既有公开 API** 复用;`assembleApp()` 是**抽取**而非重写,cli 行为字面不变。
- **不起独立大脑进程 / 不引 WS 网关**:主进程 in-process 装配(同一进程,像 cli 单机形态),不走 `CHAT_A_TRANSPORT=websocket`。
- **不做真硬件 / 真模型 / 真网络 / Electron GUI 自动化验证**:免提连续对话(真麦克风/扬声器)、真 DashScope 流式、Electron 窗口真启动属**真机待验证**;本 change 用 FakeLlm/假总线写不触网单测覆盖**会话装配 + IPC 消息映射纯逻辑**。
- **不引前端重框架**(React/Vue 等):渲染层纯 HTML/CSS/TS,esbuild 打包。
- **不做完整 electron-builder 打包发布**:`desktop:build` 仅占位脚手架(填 electron-builder 配置即可打包),不在本 change 验证产物。

## Capabilities

### New Capabilities
- `desktop-electron-frontend`:Electron 桌面前端——主进程 in-process 复用 `assembleApp()` 装配(Conversation + 记忆 + 人格 + qwen)、经类型化 IPC 暴露"想/记/说"给渲染层(`chat:send` 流式回 token+reply、`state:change`/`mood:change`/`voice:transcript` 推送);preload 安全桥(`contextIsolation`/无 `nodeIntegration`);纯 HTML/CSS/TS 渲染层(消息气泡 + 输入框 + 语音开关 + 状态栏)。**文字路真可用**(接 qwen);**语音路结构就位**(`NodeAudioDevice`+`VoiceLoop`),**naudiodon 不可用→优雅降级**(语音按钮禁用 + 提示,文字不受影响、绝不崩)。会话装配 + IPC 映射纯逻辑可单测(FakeLlm/假总线,不触网),Electron 运行时/真音频真机待验。

### Modified Capabilities
<!-- 不破坏任何既有 spec REQUIREMENT:本 change 为新增能力。共享装配为**抽取重构**——cli 行为逐字不变,既有 cli/cli-voice/assembly 测试全绿;providers/memory/persona/runtime 内部零改动。 -->

## Impact

- **影响 canonical 章节**:§2(拓扑:桌面前端是瘦客户端的图形形态,主进程 in-process 装大脑,等价单机 CLI 形态)、§4(语音:复用既有 STT/Omni 双路径 + AudioDevice 接缝,naudiodon 降级沿用 §3.2)、§6(人格:状态栏读 persona 情绪/PAD 摘要)、§3.1(只经类型化接缝 + 公开 API 复用,IPC 契约为新接缝)、§3.2(优雅降级:naudiodon 缺失/会话出错都降级,文字绝不崩;行为即配置:语音路/provider 全经 env)。与权威设计一致。
- **代码**:新增 `packages/desktop/**`(main/preload/renderer/ipc-contract + 测试 + README);`packages/client/src/assembly/app.ts`(抽取共享装配)+ `cli.ts` 改为调用它(最小重构,行为不变)。**不改** runtime/providers/memory/persona/autonomy/gateway/voice-detect 内部源码。
- **依赖**:`packages/desktop` 新增 `electron` + `naudiodon`(运行时可选,动态 import)dependency;`electron-rebuild` + `esbuild` + `@types/node` devDep。既有包不引新依赖。
- **降级/默认**:语音默认关(渲染层不点语音按钮即纯文字);`voice:start` 时若 naudiodon 不可用 → 回 `voice:unavailable` + 中文原因,语音按钮禁用,文字路不受影响(§3.2)。会话装配/回合出错经 IPC 回 `chat:error` 友好中文文案,主进程绝不崩。
- **延迟预算**:IPC 在主↔渲染同机进程间,token 经 `webContents.send` 逐 token 推送(流式贯穿,不攒批);状态/心情为低频回合级事件。对首字延迟无额外网络跳;in-process 装配等价 CLI 单机形态。
- **测试**:新增 `assembleApp()` 装配单测(FakeLlm → 发文字→收流式 token + reply;cleanup 幂等)、IPC 消息映射纯逻辑单测(总线事件 → state 派生;send 编排回 token/reply/error;voice unavailable 降级映射);**既有 cli/cli-voice/assembly 全量回归保持绿**(抽取重构不破坏行为)。
- **真机待验证(本 change 不验证)**:`pnpm desktop:dev` 真启动 Electron 窗口、渲染层发文字看到 qwen 流式回复、`pnpm desktop:rebuild` 后真麦克风「免提连续对话」语音闭环、naudiodon 缺失时语音按钮真禁用提示、electron 二进制是否成功下载安装。
