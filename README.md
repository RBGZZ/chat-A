# chat-A · 实时语音对话陪伴 Agent「小雪」

打造**长期伴侣**而非谈话助手——有自己的性格、情绪、记忆与故事,会主动、会反对;人格由**用户自定义**。

> 权威设计见 `docs/chat-a-canonical-design.md`(Canonical v1.0)。本 README 只讲"怎么跑起来和小雪聊天"。

## 快速开始(文字对话)

环境:Node ≥ 22、pnpm 11。

```bash
pnpm install        # 安装依赖
pnpm dev            # 启动交互式 CLI,和小雪打字对话
```

启动后会看到一张横幅(当前模型、记忆后端、人格旋钮、命令提示),然后就能直接打字对话。
按 `Ctrl+C` 或输入 `/quit` 退出。

Windows 也可以双击 `start.bat`(它会读取 `.env.local` 并调用 `pnpm dev`)。

### 配置真模型(默认 DeepSeek)

不配置任何 key 时会用内置的 **FakeLLM 占位**(只回固定话术,方便先跑通)。要和真模型对话,在**项目根**新建 `.env.local`,写一行:

```dotenv
# .env.local(已被 .gitignore,不会提交)
CHAT_A_LLM_API_KEY=sk-你的key
```

`pnpm dev` 和 `start.bat` 都会自动加载 `.env.local`。默认 provider 为 DeepSeek、模型 `deepseek-v4-flash`(在 `start.bat` 里设定,也可在 `.env.local` 覆盖)。

> 真实环境变量优先:若进程里已设置了某个变量,`.env.local` 的同名项不会覆盖它。

### 切换到 Qwen(DashScope,已验证可用)

```dotenv
# .env.local
CHAT_A_LLM_PROVIDER=qwen
CHAT_A_LLM_MODEL=qwen-plus
CHAT_A_LLM_API_KEY=sk-你的DashScope-key
```

其它厂商同理:`CHAT_A_LLM_PROVIDER` / `CHAT_A_LLM_MODEL` / `CHAT_A_LLM_API_KEY`(可选 `CHAT_A_LLM_BASE_URL` 覆盖 OpenAI 兼容端点)。

## 斜杠命令

对话中输入以下命令(不区分大小写):

| 命令 | 作用 |
| --- | --- |
| `/help` | 显示命令一览 |
| `/persona` | 查看当前人格与情绪旋钮 |
| `/clear` | 清屏 |
| `/reset` | 清空当前会话上下文,开新一段对话(长期记忆仍保留) |
| `/quit`(`/exit`) | 退出 |

直接打字即为普通对话;未知 `/xxx` 会提示而不会发给模型。

## 语音模式(可选)

加 `--voice` 或设 `CHAT_A_VOICE=1` 进入语音模式;默认用占位音频/STT/TTS(无原生依赖即可启动)。真设备/真 VAD-EOU 的接入见 `packages/client/src/cli-voice.ts` 与 canonical 设计。

```bash
pnpm dev --voice
```

## 其它能力开关(行为即配置,默认全关/保守)

均经环境变量开启,详见 `start.bat` 注释与 canonical 设计,例如:

- `CHAT_A_MEMORY_BACKEND=memory` 用内存记忆(默认 SQLite,跨重启记得)
- `CHAT_A_STRATEGY=tools` 启用本地动作工具循环(Agent loop)
- `CHAT_A_APPRAISER=llm` / `CHAT_A_STANCE=llm` / `CHAT_A_REFLECTION=llm` 等 LLM 认知升级
- `CHAT_A_PERSONA_CARD=persona.yaml` 用自定义人格卡(见 `persona.example.yaml`)

## 测试

```bash
pnpm -r typecheck   # 全包类型检查
npx vitest run      # 全量单测
```
