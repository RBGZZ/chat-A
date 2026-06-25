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

## 「填一个 key 即测」语音(无原生依赖,推荐先跑这条)

只想**听一下**小雪用真嗓子说话?不需要装任何原生库(naudiodon)、不需要本地模型、不需要 Windows 构建链——**只填一个 DashScope key 即可**:

1. 在**项目根** `.env.local`(已被 `.gitignore`)写一行:
   ```dotenv
   CHAT_A_DASHSCOPE_API_KEY=sk-你的DashScope-key
   ```
2. 跑:
   ```bash
   pnpm test:voice            # 或 pnpm test:voice "你想对小雪说的话"
   ```
   这会走 **100% key-only** 路径:文本输入 → 云 LLM(qwen)→ 云 TTS(qwen-tts)→ 写出 `out.wav`,用任意播放器试听即可。

想先确认 key/网络通(只测 TTS 的真 WebSocket 握手 + PCM 回流):
```bash
pnpm smoke:qwen            # 需真网络;无 key 时会跳过并提示。默认不进 CI
```

### 涉及的 env 开关(默认值)

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CHAT_A_DASHSCOPE_API_KEY` | 无 | DashScope key;LLM/TTS/(云)STT 都回落到它 |
| `CHAT_A_AUDIO_DEVICE` | `fake` | `wav` = 无原生依赖的 WAV 文件设备(读 WAV 当麦克风 / 写 WAV 当扬声器);`node` = 真原生(需 naudiodon) |
| `CHAT_A_AUDIO_IN_WAV` / `CHAT_A_AUDIO_OUT_WAV` | 无 / `out.wav` | WAV 设备的输入(须 16k/mono/s16le)/ 输出路径 |
| `CHAT_A_VAD` | `stub` | `energy` = 无模型能量 VAD + 静音超时 EOU(零模型/零原生);`silero` = 真 ONNX(需模型) |
| `CHAT_A_STT_KIND` | 无→`fake` | `qwen` = DashScope 云 ASR(OpenAI 兼容 `/audio/transcriptions`,`qwen3-asr-flash`) |
| `CHAT_A_TTS_KIND` | 无→`fake` | `qwen-tts` = DashScope WS 流式 TTS;`cosyvoice` = CosyVoice run-task WS(高保真复刻音色,见下) |
| `CHAT_A_VOICE_CLONE_KIND` | `qwen` | `cosyvoice` = 用 CosyVoice v3.5-flash 复刻(保真更高);`qwen` = 千问云复刻 |
| `CHAT_A_LLM_PROVIDER` | 见 start.bat | `qwen` 用 DashScope 纯文本(`pnpm test:voice` 已自动设好) |

#### CosyVoice 音色复刻 + 合成(高保真,北京地域)

qwen 云复刻保真度较低("不像")时,改用 **CosyVoice v3.5-flash**(零样本复刻,保真更高):

- 复刻:设 `CHAT_A_VOICE_CLONE_KIND=cosyvoice`,desktop"一键复刻"选本地 15~20s 录音即可——本地文件经 DashScope 临时上传转 `oss://` URL(无需自备 OSS),创建后**异步部署**(轮询约几分钟到 `OK`)。复刻成功自动写回 `CHAT_A_TTS_KIND=cosyvoice` + `CHAT_A_TTS_MODEL=cosyvoice-v3.5-flash` + `CHAT_A_VOICE_ID`。
- 合成:`CHAT_A_TTS_KIND=cosyvoice`,合成 `model` 须与复刻 `target_model` **逐字一致**(均 `cosyvoice-v3.5-flash`);音色经 `CHAT_A_VOICE_ID` 流入。
- 约束:CosyVoice v3.5-flash **仅北京地域、无系统音色**(必须先复刻才能合成)。
- ⚠️ 几处契约点待真机校准(隔离在可改函数,不通改一处):临时上传 getPolicy 的 `model` 参数、create_voice 接受 `oss://`+解析头、合成 WS 端点二选一、合成期语种参数——详见 `openspec/changes/cosyvoice-clone-synth/design.md` 的 Open Questions。

#### 情感控制(CosyVoice instruction)

- **静态**:`CHAT_A_TTS_INSTRUCTION=温柔一点,语气轻松自然`(自然语言情绪指令,≤100 字符)→ 所有回复同一语气;`CHAT_A_TTS_ENABLE_SSML=1` 启用 SSML。
- **随心情**:`CHAT_A_TTS_EMOTION_FROM_MOOD=on` → 朗读按小雪当前 PAD 心情自动注入情绪指令(开心→上扬、低落→低沉…),复刻音色逐回合随情绪变。默认 off=回落静态、零回归。
- ⚠️ instruction 与语速解耦:语速请用 `CHAT_A_TTS_RATE`(0.5~2.0),指令里别写"语速快/慢"以免打架。**情感随心情仅对 cosyvoice 引擎生效**(qwen-tts 忽略 per-call instruction)。

### 各路径能跑到什么程度(如实说明)

- **100% key-only(`pnpm test:voice`)**:文本→云 LLM→云 TTS→WAV。只需 key + 网络,**绝对可跑**。
- **全语音(WAV→云 STT→云 LLM→云 TTS→WAV)**:设 `CHAT_A_AUDIO_DEVICE=wav`、`CHAT_A_STT_KIND=qwen`、`CHAT_A_VAD=energy`、`CHAT_A_VOICE=1` 即可接通;其中**云 STT(`qwen3-asr-flash` 经 OpenAI 兼容端点的 multipart 上传往返)尚待真网络确认**,接缝已就位,若真机不通改一处配置即可。
- **真麦克风/扬声器**:仍需原生库 **naudiodon**(需 MSVC 构建链),`CHAT_A_AUDIO_DEVICE=node`——**这条 key 解决不了**,本节不涉及。

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
