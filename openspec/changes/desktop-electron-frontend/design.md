# 设计:Electron 桌面前端

## 1. 进程拓扑(§2)

```
┌─────────────────────────── Electron 应用 (单机, 一进程组) ───────────────────────────┐
│                                                                                       │
│  主进程 (Node, main.ts)                          渲染进程 (Chromium, 沙箱)            │
│  ┌──────────────────────────────────┐           ┌────────────────────────────────┐  │
│  │ loadEnvLocal() (复用 env-file)    │           │  index.html + renderer.ts      │  │
│  │ assembleApp() (复用 client 装配)  │           │  纯 HTML/CSS/TS, esbuild 打包  │  │
│  │   = llm(qwen) + bus + memory      │  IPC      │  · 消息气泡 (用户/小雪)        │  │
│  │     + persona + Conversation      │ ◄───────► │  · 输入框 + 发送               │  │
│  │ 订阅 LightVoiceBus → 派生 state   │           │  · 语音开关按钮                │  │
│  │ voice:start → startVoiceMode      │           │  · 状态栏 (state + 心情)       │  │
│  │   (NodeAudioDevice + VoiceLoop)   │           └────────────────────────────────┘  │
│  └──────────────────────────────────┘                  ▲ contextBridge (preload.ts)  │
│              ▲ window.xiaoxue.* (安全 IPC 桥, 仅暴露白名单方法) ┘                       │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

**等价单机 CLI 形态**:主进程像 `cli.ts` 一样 in-process 装大脑(同一进程),**不**起独立大脑/WS 网关(`CHAT_A_TRANSPORT` 保持 inprocess)。

## 2. 共享装配抽取 `assembleApp()`(最小重构,§3.1)

cli.ts 现在把"env + llm + bus + memory + persona + Conversation 工厂 + 一堆可选子系统 + cleanup"全揉在 `main()` 里(交互壳与装配混在一起)。为 desktop 复用,抽一个**无交互副作用**的核心装配:

- 新建 `packages/client/src/assembly/app.ts`,导出 `assembleApp(opts?: { env?, argv? }): AppHandle`。
- `AppHandle` 形态(只含 desktop + cli 都要的核心):
  ```ts
  interface AppHandle {
    readonly bus: LightVoiceBus;
    readonly llmConfig: LlmConfig;       // provider/model(状态行/横幅用)
    readonly memoryInfo: { backend: string; dbPath?: string };
    readonly seed: PersonaSeed;          // 人格名/旋钮(横幅/persona 命令用)
    readonly persona: PersonaEngine;     // 读当前心情(mood 摘要)
    convo: Conversation;                 // 当前会话(reset 后换新)
    sessionId: string;
    readonly makeConvo: (sid: string) => Conversation;  // /reset 用
    reset(): void;                       // 换 sessionId + 重建 convo
    readonly composeOmniInstructions: () => string | Promise<string>;
    cleanup(): Promise<void>;            // 幂等收尾(关库/trace/telemetry/reflect/consolidation)
    // 语音/感知/autonomy/巩固的可选装配钩子(cli 与 desktop 各自接,默认关时零开销)
    readonly env: NodeJS.ProcessEnv;
  }
  ```
- **抽取范围保守**:把现成 `main()` 里 llm/bus/memory/persona/Conversation 工厂/收尾段**原样搬入** `assembleApp`(逻辑不动),cli.ts 改为 `const app = assembleApp(); ...` 后续 readline/横幅/命令/语音/autonomy 接线**留在 cli.ts**(它们要 stdout 交互)。
- **保 cli 行为逐字不变**:抽取后 cli 启动横幅、状态行、`/reset`、语音、autonomy、巩固、退出收尾全等价;既有 `commands.test`/`cli-voice-wiring.test`/`assembly-*.test`/`env-file.test` 全绿。
- desktop 主进程只用到 `assembleApp` 返回的**核心子集**(bus/convo/persona/reset/cleanup/composeOmniInstructions/env);autonomy/感知/巩固等高级子系统 desktop MVP **不接**(默认关,零构造),但 env 透传后用户设了也能由共享装配挂上(若抽取时一并搬入)。**MVP 保守:desktop 只接核心**,高级子系统作后续增量。

> 取舍:不把 cli 的**全部**子系统都强行抽进 `assembleApp`(那会放大爆炸半径);只抽 desktop 与 cli 共用的**核心装配**,其余接线留各前端。这满足"最小重构、cli 行为不变"。

## 3. IPC 契约(新接缝,§3.1 类型化边界)

`packages/desktop/src/ipc-contract.ts`——**纯类型 + channel 常量 + 可单测的映射纯函数**(不 import electron,故可在 vitest 里测):

```ts
// channel 常量(单一真相源)
export const IPC = {
  send: 'chat:send', voiceStart: 'voice:start', voiceStop: 'voice:stop',
  reset: 'session:reset', getInfo: 'app:get-info',          // 渲染 → 主 (invoke)
  token: 'chat:token', reply: 'chat:reply', error: 'chat:error',
  state: 'state:change', mood: 'mood:change', transcript: 'voice:transcript',
  voiceStatus: 'voice:status',                               // 主 → 渲染 (send)
} as const;

export type UiState = 'idle' | 'listening' | 'thinking' | 'speaking';
export interface MoodSummary { emotion: string; pleasure: number; arousal: number; dominance: number; }
export interface VoiceStatus { available: boolean; reason?: string; path?: string; device?: string; }
export interface AppInfo { name: string; provider: string; model: string; memory: string; isFake: boolean; warmth: number; expressiveness: number; volatility: number; }
```

**state 派生纯函数**(可单测,无 electron 依赖):订阅 LightVoiceBus,把粗粒度总线事件归约成 UI 四态——
- `turn:start` → `thinking`;`tts:first_audio` → `speaking`;`turn:end` → `idle`;
- `vad:speech_start` → `listening`;`vad:speech_end` → (回合未结束)`thinking`。
- 抽成 `deriveState(prev, event): UiState` 纯函数 + 一个 `StateTracker` 类(持当前态,订阅总线时调用),`StateTracker` 用假总线单测。

**mood 摘要**:回合后(`turn:end`)读 `persona.tone()` 的 `{ emotion, pad }` → `MoodSummary`。抽 `toMoodSummary(tone): MoodSummary` 纯函数单测。

**send 编排**(主进程,可抽成接口注入 convo/webContents 以单测):`chat:send(text)` → `convo.send(text, onToken)`,`onToken` 经 `webContents.send(IPC.token, t)` 逐 token 推;resolve → `IPC.reply` 推完整回复;catch → `IPC.error` 推友好中文降级文案(主进程绝不崩,§3.2)。抽 `runSendTurn({ send, emit }, text)` 纯编排函数,用 FakeLlm 风格的假 send + 假 emit 单测「token 序列 + reply / error」。

## 4. preload 安全桥

`contextIsolation:true` + `nodeIntegration:false` + `sandbox:true`。preload 用 `contextBridge.exposeInMainWorld('xiaoxue', {...})` 只暴露白名单:
- `send(text)`、`voiceStart()`、`voiceStop()`、`reset()`、`getInfo()` → 经 `ipcRenderer.invoke`。
- `onToken(cb)`、`onReply(cb)`、`onError(cb)`、`onState(cb)`、`onMood(cb)`、`onTranscript(cb)`、`onVoiceStatus(cb)` → 经 `ipcRenderer.on` 包装(返回取消订阅函数;不泄漏 `ipcRenderer` 本体)。

## 5. 语音路 + naudiodon 优雅降级(§3.2/§4)

- `voice:start`:主进程设 `env.CHAT_A_AUDIO_DEVICE='node'`(若用户未显式设),调既有 `startVoiceMode({ send: (t,cb)=>app.convo.send(t,cb), composeOmniInstructions: app.composeOmniInstructions, memory, bus, sessionId, env })`。
  - `startVoiceMode` 内部:`createAudioDevice` 对 `node` 档会 `await device.init()` 动态 import naudiodon——**装不上则抛错**。但 `startVoiceMode` 已在 catch 里回落 Fake 设备(不抛)。
  - 为给 UI **明确**降级信号,desktop 主进程在调 `startVoiceMode` **前**先**显式探测** naudiodon 可用性:`new NodeAudioDevice().init()` 包 try/catch;失败 → 直接回 `voice:status { available:false, reason:'语音需安装原生音频(见 README)' }`,**不进** `startVoiceMode`(避免静默回落 Fake 让用户以为语音在跑)。成功 → 进 `startVoiceMode`,回 `voice:status { available:true, path, device }`。
  - 探测/启动全程 try/catch,任何失败都回 `voice:status{available:false,reason}`,**文字路不受影响、主进程绝不崩**。
- `voice:stop`:调 `voiceHandle.stop()`(幂等)。
- 渲染层:`onVoiceStatus`,`available:false` → 语音按钮 `disabled` + tooltip 显示 reason;`available:true` → 按钮高亮"语音中"。

## 6. 渲染层(纯 HTML/CSS/TS,esbuild)

- `index.html`:聊天区(`#messages`)+ 输入行(`#input` + `#send`)+ 顶栏状态(`#state` + `#mood`)+ 语音按钮(`#voice`)。
- `renderer.ts`:订阅 `window.xiaoxue.on*`,把 token 追加到"小雪"当前气泡;`onReply` 收尾气泡;`onState`/`onMood` 更新状态栏;发送时新建用户气泡 + 占位小雪气泡。
- `styles.css`:简洁中文 UI(气泡左右分、状态栏配色、深浅适中)。
- esbuild 把 `renderer.ts` 打成 `renderer.js`(IIFE,供 `<script>` 引);main/preload 用 tsx 直跑或 esbuild 打 CJS(electron main 需 CJS 或带 `"type"` 适配)。

## 7. 构建/运行脚本

- `desktop:dev`:`electron packages/desktop/`(main 入口);dev 下 main/preload 经 esbuild 预打包到 `dist/`,再 `electron .`。
- `desktop:rebuild`:`electron-rebuild -f -w naudiodon`(用 electron 的 ABI 重编原生模块)。
- `desktop:build`:`electron-builder`(占位配置;本 change 不验证产物)。

## 8. 测试边界(§3.2 可测试性)

**Headless 可单测(本 change 覆盖,不触网/不碰 electron/不碰真音频)**:
1. `assembleApp()`:FakeLlm provider(`CHAT_A_LLM_PROVIDER=fake` 或无 key)→ `convo.send('你好', onToken)` → 断言收到流式 token + 非空 reply;`reset()` 换 sessionId 重建 convo;`cleanup()` 幂等(多次调不抛)。
2. `deriveState`/`StateTracker`:喂总线事件序列(turn:start/tts:first_audio/turn:end/vad:*)→ 断言 UI 四态迁移。
3. `toMoodSummary`:给定 tone → 断言摘要字段。
4. `runSendTurn`:假 send(吐若干 token + reply)→ 断言 emit 序列(token×N + reply);假 send 抛错 → 断言 emit error(友好文案)、不抛。
5. naudiodon 探测降级映射:`probeVoice` 用一个"init 抛错"的假设备 → 回 `{available:false, reason}`;"init 成功"的假设备 → `{available:true}`。

**真机待验(本 change 不验证)**:Electron 窗口真启动、渲染层真发文字看到 qwen 流式、`desktop:rebuild` 后真麦克风免提连续对话、naudiodon 真缺失时按钮真禁用、electron 二进制下载安装。
