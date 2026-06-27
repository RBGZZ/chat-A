# VRChat 集成生态调查报告

**日期**: 2026-06-27 | **目的**: chat-A 后续接入 VRChat 的集成路径评估与开源方案参考

---

## 一、可行路径矩阵

| 路径 | 可行性 | 官方支持 | 用途 |
|------|--------|----------|------|
| **OSC** (UDP 9000/9001) | ✅ | 官方支持 | Avatar 参数、Chatbox 文字、输入控制 |
| **虚拟音频设备** | ✅ | 系统级 | TTS 语音注入 VRChat 麦克风 |
| **VRChat REST API** | ⚠️ | 社区逆向 | 好友/世界/通知/用户查询 |
| **WebSocket Pipeline** | ⚠️ | 社区逆向 | 实时好友在线/位置推送 |
| **客户端 Modding** | ❌ | EAC 封禁 | 不可用（2022年7月起 EAC 全封） |

---

## 二、推荐架构：三通道并行

```
chat-A Brain (Node.js)
    │
    ├─ OSC :9000 ──────────────────► VRChat
    │   ├─ /chatbox/input          对话文字气泡（144字节，仅ASCII）
    │   ├─ /chatbox/typing         打字指示器
    │   ├─ /avatar/parameters/*    表情/口型/动作参数
    │   └─ /input/*                移动/跳跃等角色自主行为
    │
    ├─ 虚拟音频 ───────────────────► VRChat
    │   TTS输出 → VB-Cable → VRChat 麦克风输入（~14ms延迟）
    │   VRChat音频 → 第二根虚拟线 → chat-A STT 听别人说话
    │
    └─ VRChat API (REST + WS) ────► 社交上下文
        ├─ WebSocket Pipeline      好友上线/离线/位置实时事件
        ├─ REST /api/1/auth/user   用户信息、好友列表
        └─ REST /api/1/instances   当前世界/实例元数据
```

---

## 三、VRChat OSC 能力详情

### 3.1 三大 API 端点

默认端口 9000（传入）/ 9001（传出），地址 127.0.0.1。

| API | 地址模式 | 支持类型 | 用途 |
|-----|---------|---------|------|
| **Avatar Parameters** | `/avatar/parameters/{Name}` | `int`, `float`, `bool` | 控制 Avatar 动画/状态 |
| **Chatbox** | `/chatbox/input`, `/chatbox/typing` | `string` + `bool` | 发送文字到聊天框 |
| **Input Control** | `/input/{ActionName}` | `int`(按钮)、`float`(轴) | 模拟游戏输入 |

### 3.2 VRChat 自动发出的参数（Outgoing，从 VRChat 到外部程序）

| 参数 | 类型 | 含义 |
|------|------|------|
| `/avatar/parameters/Viseme` | int (0-14) | 口型：0=Sil, 1=PP, 2=FF, 3=TH, 4=DD, 5=KK, 6=CH, 7=SS, 8=NN, 9=RR, 10=AA, 11=E, 12=IH, 13=OH, 14=OU |
| `/avatar/parameters/Voice` | float (0-1) | 语音能量/音量 |
| `/avatar/parameters/GestureLeft` | int | 左手手势 |
| `/avatar/parameters/GestureRight` | int | 右手手势 |
| `/avatar/change` | string | Avatar 切换时发出新 Avatar ID |

### 3.3 Avatar 参数限制

- 数据类型仅限 `int`、`float`、`bool`，**不能直接发送 string 给 avatar parameter**
- 同步参数预算：**256-bit 硬上限**（所有 synced 参数合计），local-only 不计入
- 总参数数不超过 256 个（含 synced+local）
- 内置参数（Viseme, Gesture*, Voice 等）不占预算
- Chatbox：约 144 字节，仅 ASCII

### 3.4 频率与延迟

- OSC 消息按帧率处理（20-90 Hz），足够驱动口型/表情
- UDP localhost 延迟 <1ms，瓶颈在 VRChat 内部处理
- 高频逐帧 blend shape 更新完全可行（多个项目已验证）

---

## 四、关键开源项目（按相关度排序）

### 4.1 AI 语音伴侣类（与 chat-A 直接相关）

| 项目 | Stars | 语言 | 许可 | 核心功能 |
|------|-------|------|------|----------|
| **AIAvatarKit** | 614 | Python | MIT | LLM→VRChat 全链路。支持 ChatGPT/Claude/Gemini + Whisper STT + VOICEVOX/OpenAI TTS + 表情动画 OSC 控制。**最接近 chat-A 目标的参考实现** |
| **TTS-Voice-Wizard** | 590+ | C# | MIT | mute 玩家 TTS 标准方案。STT→TTS→OSC Chatbox + KAT 文字显示 + 100+ 语音 + 50+ 语言翻译 |
| **vrc-tts-osc** | 小 | Python | - | TTS+OSC 最简实现。OpenAI/ElevenLabs TTS + AI Bot 对话模式 + Chatbox 同步 |
| **VRChat-AI-Bot** | 小 | Python | - | Character.AI + Google STT/TTS + 双虚拟线全双工 |
| **Project Gabriel** | 小 | Python | 部分开源 | Gemini Live AI + YOLOv11 视觉 + OSC + 记忆系统 |
| **VRCLT** | 小 | Python | - | Gemini 实时翻译 + 虚拟声卡 TTS 注入 + SteamVR 字幕叠加 |

**共性架构**：`[AI/LLM 后端] → [TTS 合成] → [虚拟声卡输出] → VRChat 麦克风` + `[OSC] ↔ [Avatar 参数/表情/Chatbox 文字]`

### 4.2 OSC 工具箱类

| 项目 | Stars | 语言 | 核心功能 |
|------|-------|------|----------|
| **VRCOSC** | 346 | C# (osu!framework) | 模块化 OSC 自动化平台，20+ 内置模块（媒体控制/心率/STT/天气），自定义 Pulse 节点编程，SDK 供第三方开发 |
| **SubLink** | 中 | C# | OSC 双向集成框架，Twitch/Kick → VRChat |
| **VRChat MCP OSC** | 20 | TypeScript | MCP Server → VRChat OSC（set_avatar_parameter, move_avatar, send_message 等）——**与 chat-A 同技术栈** |

### 4.3 Avatar SDK / Face Tracking 类

| 项目 | Stars | 语言 | 核心功能 |
|------|-------|------|----------|
| **VRCFaceTracking** | 738 | C# | 社区面捕标准中间件。模块化硬件桥接，Unified Expressions 52+ 参数。可通过 RFC#128 OSC 输入接口注入合成数据 |
| **Av3Emulator** | 569 | C# (Unity) | Unity Editor 内完整模拟 VRChat AV3 运行时——无需上传即可测试 Animator/参数/OSC |
| **KillFrenzyAvatarText** | 200+ | Unity | Avatar 身上渲染文字（比 Chatbox 更灵活），用 4/8/16 个 sync Int 参数编码字符索引 |
| **OscAvMgr** | ~50 | Rust | Linux 版 VRCFT 替代（Quest Pro/Pico/HTC） |

### 4.4 VRChat API / 辅助工具类

| 项目 | Stars | 语言 | 核心功能 |
|------|-------|------|----------|
| **VRCX** | 高 | Electron+Vue+.NET | 好友/世界/模型管理，日志实时解析，Discord Rich Presence，崩溃自动恢复 |
| **vrchatapi** | 高 | OpenAPI+7语言 | 社区维护的 OpenAPI 规范 + JavaScript/Python/C#/Rust/Java/Go/Dart SDK |
| **VRChatActivityViewer** | 小 | Node.js CLI | VRChat 日志解析，好友活动过滤，时间范围查询 |

### 4.5 参考 VR 社交平台

| 平台 | 状态 | 参考价值 |
|------|------|----------|
| **Resonite** (ex-NeosVR 团队) | 活跃 | Protoflux 可视化脚本、WebSocket/API 集成架构、跨世界库存 |
| **UNAVI** | 早期 | Bevy(Rust) + WebAssembly，开源架构参考 |
| **XREngine** | MIT | ECS 架构、空间 Web 引擎设计 |

---

## 五、口型/表情驱动方案

### 5.1 三种方案对比

| 方案 | 复杂度 | 保真度 | 实现路径 |
|------|--------|--------|----------|
| **A: OSC 直写 Viseme** | 低 | 15 口型 | TTS viseme 时间戳 → `/avatar/parameters/Viseme` (int 0-14)，Avatar 需设 "Viseme Parameter Only" 模式 |
| **B: OSC 自定义 BlendShape** | 中 | 可定制 | TTS viseme → 自定义 blend shape 参数（MouthOpen/JawForward/LipWidth 等），彻底绕过 VRChat 内置唇同步 |
| **C: VRCFT 桥接** | 高 | 52+ ARKit | chat-A 合成面捕数据 → VRCFT RFC#128 OSC 输入 → VRCFT Unified Expressions → Avatar。表情最丰富但需额外运行 VRCFT（Windows-only C#/WPF） |

**推荐第一期走方案 A**，后续可按需升级到方案 B 或 C。

### 5.2 情绪→表情映射草案

```
chat-A PAD 情绪          →  OSC 参数
─────────────────────────────────────
中性                      →  FaceIndex = 0
喜悦 (P↑ A↑)             →  FaceIndex = 1 (smile)
悲伤 (P↓ A↓)             →  FaceIndex = 2 (frown)
愤怒 (P↓ A↑ D↑)          →  FaceIndex = 3 (angry)
惊讶 (P↑ A↑ D↓)          →  FaceIndex = 4 (surprised)
赌气 (P↓ A↓ D↑, sulking) →  FaceIndex = 5 (pout)
主动说话                  →  VRCEmote = 对应动画索引
idle/思考中               →  idle_state = 1
```

参考 AIAvatarKit 标签解析模式：LLM 输出 `[face:joy]` `[animation:wave:3]` → OSC 参数值映射。

---

## 六、音频注入方案

### 6.1 技术方案

| 方案 | 延迟 | 稳定性 | 复杂度 | 推荐 |
|------|------|--------|--------|------|
| **VB-Cable** | ~14ms | ⭐⭐⭐⭐⭐ | 极低 | ✅ 首选 |
| **Voicemeeter Banana** | ~20-40ms | ⭐⭐⭐⭐⭐ | 低 | ✅ 多总线场景 |
| Windows WASAPI 自研 | 不确定 | ⭐⭐ | 极高 | ❌ 不值得 |

### 6.2 延迟预算

```
TTS 合成延迟:       50-300ms (取决于引擎和云端/本地)
VB-Cable 路由延迟:  ~14ms
VRChat 处理延迟:    ~10-20ms (估计)
网络传输延迟:       ~20-50ms (P2P)
─────────────────────────────────
总延迟:             ~94-384ms
```

人类对话自然响应延迟约 200-500ms，可接受。

### 6.3 关键参数

- 采样率：48000 Hz（匹配 Windows 音频子系统），16-bit PCM mono
- 全双工需 **2 根虚拟线**：一根注入 TTS 输出，一根捕获 VRChat 音频做 STT
- VRChat 内置噪声抑制对 TTS 类人语音**通过性良好**（所有现有项目已验证）
- VRChat 设置：关闭降噪、激活阈值设 0%，否则 TTS 音频可能被过滤

### 6.4 跨平台方案

| 操作系统 | 虚拟音频方案 |
|---------|------------|
| **Windows** | VB-Cable (免费) / Voicemeeter Banana (免费) |
| **macOS** | BlackHole (开源) / Loopback (付费 $99) |
| **Linux** | PipeWire Loopback + `pactl load-module module-loopback` |

---

## 七、VRChat REST API（社区维护）

### 7.1 核心端点

| 领域 | 端点 | 说明 |
|------|------|------|
| 认证 | POST `/api/1/auth/user` | 用户名+密码 → `authcookie`（需处理 2FA） |
| 好友 | GET `/api/1/auth/user/friends` | 好友列表（支持 n/offset/offline） |
| 通知 | GET `/api/1/auth/user/notifications` | 通知列表（邀请/好友请求等） |
| 世界 | GET `/api/1/worlds` | 世界搜索/列表 |
| 实例 | GET `/api/1/instances/{worldId}:{instanceId}` | 实例详情 |
| 用户 | GET `/api/1/users/{userId}` | 用户信息（显示名/状态/Bio） |

### 7.2 WebSocket Pipeline（实时事件）

地址：`wss://pipeline.vrchat.cloud/?authToken=<authcookie>`（只接收）

核心事件：`friend-online` / `friend-offline` / `friend-location` / `notification` / `user-update`

**重要**：好友在"请勿打扰(红色)"或"询问我(橙色)"或私密世界中时，`world` 为空对象，`location` 为 `"private"`

**频率建议**：REST 查询不超过 1 次/60 秒（社区约定），WebSocket Pipeline 无频率限制。

### 7.3 npm 生态

- **VRChat API**：`vrchat-api-library` —— 同时支持 REST + WebSocket Pipeline，成熟稳定
- **OSC**：`osc`（824 stars, 多传输层 UDP+WS+TCP+Serial, 自带 TS 类型, 浏览器+Node+Electron 全支持）
- 备选 OSC：`node-osc`（零依赖，纯 UDP，100% 测试覆盖）

### 7.4 风险提示

- VRChat API **非官方**——端点可能无预警变更，需做好适配预案
- `authcookie` 是完整权限凭证，必须安全存储，不可泄露
- 不得冒充用户自动化操作（违反 TOS），chat-A 应被标识为 AI 伴侣
- 建议只在私有/好友世界使用，不在公共世界长时间无人值守运行

---

## 八、chat-A 集成实现优先级

| 优先级 | 通道 | 实现内容 | 理由 |
|--------|------|----------|------|
| **P2** | 虚拟音频 | TTS 语音注入 + VRChat 音频捕获 | chat-A 核心价值——语音交互 |
| **P2** | OSC Chatbox | 文字消息发送 + 打字指示器 | 最低成本的 VRChat 内可见输出 |
| **P2** | OSC Viseme | TTS viseme → /avatar/parameters/Viseme 映射 | 口型同步 |
| **P3** | VRChat WebSocket | 好友在线/位置实时事件 | 社交上下文感知 |
| **P3** | OSC 表情 | 情绪→表情 OSC 映射 | 增强沉浸感 |
| **P3** | VRChat REST | 世界/实例/用户元数据查询 | 丰富上下文 |
| **P4** | KAT 文字 | Avatar 身上渲染文字 | 比 Chatbox 更灵活的显示方案 |
| **P4** | 配套 Avatar | Unity Package + 参数约定文档 | 端到端用户体验 |

---

## 九、推荐新增包结构草案

```
packages/
  vrchat-bridge/              # 新包：VRChat OSC + API 桥接
    osc-transport.ts          # 封装 osc.js，管理 UDP socket (9000/9001)
    avatar-params.ts          # VRChat 参数名常量 + 类型安全封装
    viseme-mapper.ts          # TTS viseme → VRChat blend shape 映射表
    emotion-mapper.ts         # PAD 情绪 → FaceOSC 枚举 / VRCEmote 动画映射
    chatbox-sender.ts         # 文本分片 + typing indicator 管理
    perception-adapter.ts     # VRChat 事件 → chat-A PerceptionSource 接口
    audio-bridge.ts           # 虚拟音频设备枚举/路由
    vrchat-api-client.ts      # VRChat REST + WebSocket Pipeline 封装
```

---

## 十、参考链接

### VRChat 官方/社区
- VRChat OSC 官方仓库：https://github.com/vrchat-community/osc
- VRChat OSC 文档：https://deepwiki.com/vrchat-community/osc/2-vrchat-osc-apis
- VRChat OSC Input Wiki：https://github.com/vrchat-community/osc/wiki/Input
- VRChat API 规范：https://vrchatapi.github.io/
- VRChat API OpenAPI：https://github.com/vrchatapi/specification

### 核心参考项目
- AIAvatarKit：https://github.com/uezo/aiavatarkit
- TTS-Voice-Wizard：https://github.com/VRCWizard/TTS-Voice-Wizard
- VRCOSC：https://github.com/VolcanicArts/VRCOSC
- VRCFaceTracking：https://github.com/benaclejames/VRCFaceTracking
- KillFrenzyAvatarText：https://github.com/killfrenzy96/KillFrenzyAvatarText
- VRCX：https://github.com/vrcx-team/VRCX
- VRChat MCP OSC：https://github.com/Krekun/vrchat-mcp-osc
- Av3Emulator：https://github.com/lyuma/Av3Emulator

### npm 包
- osc.js：https://github.com/colinbdclark/osc.js
- node-osc：https://www.npmjs.com/package/node-osc
- vrchat-api-library：https://www.npmjs.com/package/vrchat-api-library

### 虚拟音频
- VB-Cable：https://vb-audio.com/Cable/
- Voicemeeter：https://vb-audio.com/Voicemeeter/
- BlackHole (macOS)：https://github.com/ExistentialAudio/BlackHole
