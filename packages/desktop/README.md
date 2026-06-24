# @chat-a/desktop —— 「小雪」Electron 桌面前端

文字聊天**立即可用**;语音(原生音频 naudiodon)**结构就位 + 优雅降级**。

主进程 **in-process 复用** `@chat-a/client` 的既有装配(`assembleApp()`:Conversation + 记忆 + 人格 + provider),
经 IPC 把"想/记/说"暴露给纯 HTML/CSS/TS 渲染层。不起独立大脑、不走 WS 网关——等价单机 CLI 形态。

## 前置

- **Node ≥ 22 + pnpm**(仓库根已要求)。
- **真模型 key(文字可用的唯一必填)**:在**仓库根**新建 `.env.local`,填一行:
  ```
  CHAT_A_DASHSCOPE_API_KEY=sk-你的DashScope-key
  ```
  即默认走 Qwen(qwen-plus)。不填则回落 FakeLLM 占位(界面照常,回复是占位句)。
- **语音(可选)需原生音频构建工具链**:Windows 上装 **Visual Studio Build Tools** 的
  **「使用 C++ 的桌面开发」工作负载**(用于编译 naudiodon 的原生模块);Python 通常随其就绪。
  不装也不影响文字——语音按钮会自动禁用并提示。

## 快速开始(文字)

```bash
pnpm install          # 安装依赖(含 electron;首次会下载 electron 二进制,较慢请耐心)
pnpm desktop:dev      # 打包 main/preload/renderer 后启动 Electron 窗口
```

只要 `.env.local` 填了 key,启动后即可在输入框打字、看到小雪**流式**回复;
顶栏显示她的**状态**(空闲/在听/在想/在说)与**心情**。

## 启用语音(可选)

```bash
pnpm desktop:rebuild  # 用 Electron 的 ABI 重新编译 naudiodon 原生模块
pnpm desktop:dev      # 再启动;点麦克风按钮开始「免提连续对话」
```

- 语音走**云端** STT/TTS(默认),或设 `CHAT_A_VOICE_PATH=omni` 走 Qwen omni audio-in 直路;**不需要本地模型**。
- 若 naudiodon 未安装 / 未 rebuild,点语音按钮会得到「语音需安装原生音频(见 README)」提示,
  **语音按钮禁用、文字对话照常**(优雅降级,主进程绝不崩)。

## 脚本(在仓库根运行)

| 脚本 | 作用 |
| --- | --- |
| `pnpm desktop:dev` | esbuild 打包 + 启动 Electron(开发) |
| `pnpm desktop:rebuild` | electron-rebuild 重编 naudiodon(启用语音前一次) |
| `pnpm desktop:build` | electron-builder 打包(占位;填配置后可产分发包) |

## 行为即配置(env,均可写进 `.env.local`)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHAT_A_DASHSCOPE_API_KEY` | — | 填了即默认 Qwen 文字可用 |
| `CHAT_A_LLM_PROVIDER` / `_MODEL` / `_API_KEY` | 自动 | 显式覆盖 provider/模型/key |
| `CHAT_A_MEMORY_BACKEND` | `sqlite` | `memory` 可退回纯内存(不落库) |
| `CHAT_A_VOICE_PATH` | `stt` | `omni` 走 audio-in 直路 |
| `CHAT_A_PERSONA_CARD` | — | 指向人格卡(YAML),自定义小雪 |

## 真机待验证(headless 不覆盖)

- Electron 窗口真启动 + 渲染层发文字看到真模型流式回复;
- `desktop:rebuild` 后真麦克风「免提连续对话」语音闭环;
- naudiodon 真缺失时语音按钮真禁用提示;
- electron 二进制是否成功下载安装。

headless 已覆盖(不触网/不碰 electron/不碰真音频):会话装配 `assembleApp()`、IPC 状态派生 /
心情摘要 / 回合编排(token/reply/error)/ naudiodon 探测降级的**纯逻辑单测**。
