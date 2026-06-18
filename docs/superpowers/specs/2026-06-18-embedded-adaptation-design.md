# chat-A 嵌入式/客户端-服务端适配设计(临时草案 v0.1)

> ⚠️ **本文已并入 `docs/chat-a-canonical-design.md`(canonical v1.0,2026-06-19)**。本文保留为接缝/适配的推导过程备查;以 canonical 为准。
>
> 状态:**临时草案**,方向已与用户对齐(2026-06-18),待复审后转实施计划。
> 关系:本文是对 `docs/chat-a-final-design.md`(v2.1)的**适配增量**,不推翻原设计,只新增"音频传输边界"与部署形态抽象。
> 核心目标:**足够模块化,使未来升级(B→A 形态、云端→端侧模型、单次→Agent loop)只换实现、不动业务核心。**
>
> ⚠️ **canonical 待定**:仓库另有 `docs/real-time-agent-design.md`,已描述客户端-服务端 monorepo(`packages/protocol·gateway·runtime·providers·client`)+ WebSocket gateway + runtime turn 管理,**比 v2.1 更贴近本决策**。建议转实施前指定它为骨架、把本草案的 5 个接缝 + 校正并入,其余顶层设计标注"已归档"。**此项需用户拍板后执行,本草案暂不删改其他文档。**

---

## 0. 背景与决策汇总

| 项 | 决策 |
|----|------|
| 路线 | **云端路线**:AI 重计算(STT/LLM/TTS)走云端 API |
| 当前架构 | **B 方案(客户端-服务端分离)**:终端只收发音频,大脑在服务端/PC |
| 演进方向 | **A 方案(单体合体)**:大脑下沉到设备端,与"端侧本地化小模型"同一条线 |
| 当前阶段 | 全部在 **PC 端**测试开发(终端与大脑都先在 PC 跑通) |
| 终端目标 | **PC 端、手机端**(及树莓派纯音频终端) |
| 手机激进路线 | 算力足够的手机直接走 A 合体:本地跑完整大脑 + **Gemma 4 端侧模型**(原生音频输入) |
| 基线硬件 | 树莓派 4B(纯 CPU,仅作音频终端);未来增强(Pi 5 / 加速器 / 高性能手机) |
| 离线能力 | 当前不做硬要求;演进期随端侧模型成熟逐步具备 |

---

## 1. 总体拓扑与边界

```
┌─────────────────────────┐         ┌──────────────────────────────────────┐
│   终端 (Thin Client)     │  音频流  │          大脑 (Brain Server)           │
│   PC / 手机 / 树莓派      │◄───────►│          PC / 云服务器                  │
│                         │ WebSocket│                                        │
│  • 麦克风采集            │  (双向)  │  LightVoiceBus / Processor / 5状态      │
│  • 扬声器播放            │         │  人格引擎 / 记忆引擎 / 成本 / 日志        │
│  • (可选)本地 VAD/唤醒    │         │  LLM网关 → 云端 STT/LLM/TTS             │
└─────────────────────────┘         └──────────────────────────────────────┘
```

**单一边界:终端 ↔ 大脑之间只有一条"音频/控制"通道。**
- 上行:音频帧(PCM/Opus)+ 控制信令(本地 VAD 的 speech_start/end、interrupt、会话身份)
- 下行:合成音频帧(带 generation 标签)+ 控制信令(ai:start_speaking / interrupted / 指示灯状态)

**三种部署形态共用一套代码(只换 transport 实现 + 配置):**

| 形态 | 终端 | 大脑 | transport | 阶段 |
|------|------|------|-----------|------|
| 本地单机 | PC 进程内 | PC 进程内 | 进程内直连 | **当前测试** |
| 分离 (B) | Pi/手机 | PC/云服务器 | WebSocket | 当前目标 |
| 合体 (A) | 手机(全栈 + 端侧模型) | = 终端 | 进程内直连 | 演进 |

---

## 2. 模块职责划分(终端 vs 大脑)

原 v2.1 模块清单不变,按"终端/大脑"重新归属:

**永远在终端(贴近硬件):**
- `audio/capture`(麦克风)、`audio/player`(即时停止)、`audio/queue`(反压 maxDepth=5)
- 可选下沉:`voice/vad`(Silero)、`wake`(唤醒词)—— 下沉省上行带宽、降唤醒/中断延迟

**永远在大脑(业务核心):**
- `core/bus`、`core/processor`(generation 计数)、`core/state`(5状态 reducer)
- `personality/*`、`memory/*`、`core/cost`、`core/logger`、`core/config`
- `turn/strategy`(**应答策略 / Agent loop**,§5.5)、`autonomy/`(**后台自主 loop**,§5.6)
- `llm/gateway`(双路径路由/降级)、`llm/classifier`(3层过滤)、`tts/engine`、`stt`

**随形态迁移的"接缝"(见第 5 节):**
- `AudioTransport`(进程内 / WebSocket)—— 分离 vs 合体的唯一切换点
- `llm/providers/*`—— 云端 Provider 与未来 `gemma4-local` Provider,靠能力标记路由
- `TurnStrategy`(单次流式 / Agent loop)—— 应答方式的切换点

> 不变量:**personality / memory / bus 不感知自己跑在 PC、服务器还是手机上。**

---

## 3. 数据流 & 跨网络的"无条件中断"

原则:**中断的"体感动作"留在终端本地,中断的"算力回收"交给网络异步。**

```
用户插话 (终端本地 VAD 检测)
   │
   ├─【本地·立即】clear(AudioQueue) + player.stop()
   │   → 用户耳朵里的声音"立刻"停 (0 网络延迟)  ← 体感
   │
   └─【上行·异步】interrupt(generation) → 大脑
       → processor.allocate() → generation++ → abortAll()
       → 取消进行中的云端 LLM/TTS 调用 (仅影响省钱/省算力)
```

**generation 计数跨网络延续:**
1. 大脑下行每一帧音频打 generation 标签
2. 终端只播放 `generation == 当前值` 的帧
3. 中断瞬间终端本地 `generation++` → 取消窗口内"已在路上"的旧帧到达后不匹配 → 丢弃(防"打断后又蹦半句")

**延迟预算:**

| 环节 | 延迟 | 影响 |
|------|------|------|
| 体感停止(本地 flush) | ~即时 | UX,必须 0 等待 |
| 中断信令到大脑 | 1 RTT(LAN 1–5ms / 公网 20–80ms) | 仅云端算力浪费 |
| 旧帧丢弃 | 本地判断 | 防迟到半句 |

**两个边界:**
- **回声**:保留原 `vad.js` 的 EchoGuard,播放期间回声抑制,避免自我打断。
- **哑终端兜底**:跑不动 VAD 的终端 → VAD 在大脑端 + 上行常开音频流,中断延迟退化为 1 RTT(可接受降级档)。

---

## 4. 网络韧性(断开 / 重连 / 状态恢复)

两条网分治:

```
终端 ──①终端↔大脑──► 大脑 ──②大脑↔云端──► 云 LLM/TTS
```

- **② 大脑↔云端断开** = 原设计 Provider 故障/降级,逻辑不变(failover、退避冷却、降级、"信号不太好"播报)。
- **① 终端↔大脑断开** = 新故障,重点处理。

**状态归属:会话/业务状态在大脑,呈现状态在终端。**(措辞校正:不是"终端完全无状态")
- 终端:无**业务/会话**状态,但持有**呈现状态**——指示灯/呼吸灯、唤醒反馈、播放进度(原设计 UX 关键时刻)。断了重连只需重建音频通道 + 恢复呈现状态。
- 大脑:持有全部**会话/业务**状态(人格/记忆/对话/5状态)→ 仍落 SQLite。会话身份在终端连接时上报。
- 终端崩 → 大脑保活;大脑崩 → SQLite 恢复最后 5 轮(原设计落地)。

**检测与重连:**
```
心跳:WebSocket ping/pong(~2s,3 次丢失判定断开)
重连:指数退避 1s→2s→4s→…→上限 30s
保活窗口:终端掉线后大脑保持会话温热 N 分钟(复用 IDLE);超时转 IDLE
```

**断开瞬间体感:**

| 场景 | 终端 | 大脑 |
|------|------|------|
| AI 说话时断开 | 队列放完→静音,指示灯橙 | 检测终端消失→暂停/abort,别再烧 token |
| 用户说话时断开 | 本地提示音"断线了" | 丢弃半句,标记待恢复 |
| 短暂抖动 | 缓冲+快速重连,尽量无感 | 保活窗口内续接 |

**终端最小本地资产:** 断网时终端够不着大脑,也拿不到云端 TTS → 终端打包时**预存提示音 + 1~2 句缓存语音**,否则断网即"哑"。

---

## 5. 模块化与演进接缝(本设计重点)

> 目标:让 **B→A 形态切换** 和 **云端→端侧模型切换** 都只是"换实现 + 改配置",业务核心零改动。

### 5.1 接缝一:`AudioTransport`(部署形态的唯一切换点)

```
interface AudioTransport {
  // 上行:终端 → 大脑
  sendAudioFrame(frame)           // 麦克风音频帧
  sendControl(signal)             // speech_start/end, interrupt, identify
  // 下行:大脑 → 终端
  onAudioFrame(cb)                // 带 generation 标签的合成音频
  onControl(cb)                   // ai:start_speaking, interrupted, 指示灯
  // 生命周期
  connect() / close() / onStateChange(cb)   // connected/reconnecting/closed
}
```

实现:
- `InProcessTransport` —— 本地单机 / 手机合体,进程内直连,零序列化、零网络。
- `WebSocketTransport` —— 分离形态,含心跳、重连退避、generation 标签编解码。

**业务核心(bus/processor/人格/记忆)只依赖接口,永不 import 具体实现。** 形态切换 = 配置选 transport。

### 5.2 接缝二:Provider 能力抽象(云端↔端侧的唯一切换点)

沿用原 v2.1 的"能力驱动"抽象,不新增机制:

```
providers:
  multimodal:
    - { id: qwen-omni,   tier: cloud, audio_input: true,  priority: 1 }
    - { id: gemma4-local, tier: local, audio_input: true,  priority: 0 }  # 演进期加入
  text:
    - { id: deepseek,    tier: cloud, audio_input: false, priority: 2 }
```

- 接入 Gemma 4 端侧 = 新增一个 `tier: local, audio_input: true` 的 Provider 实现,**路由/降级逻辑不变**。
- 手机合体:`gemma4-local` priority 最高 → 本地优先,云端兜底。
- license 提醒:Gemma 系列为 "Gemma Terms of Use"(非 Apache 2.0),商用前核实。

### 5.3 接缝三:终端能力声明(终端按能力自适应形态)

终端连接时上报能力,大脑据此决定职责下沉程度:

```
terminal.capabilities = {
  vad: true|false,          # 能否本地跑 VAD(决定中断延迟档)
  wake: true|false,         # 能否本地唤醒词
  local_brain: true|false,  # 能否合体(跑完整大脑 + 端侧模型)
  codec: ["opus","pcm"],
}
```

- 弱端(Pi/低端手机):`local_brain=false` → B 瘦客户端
- 强端(可跑 Gemma4 手机):`local_brain=true` → A 合体(激进),`AudioTransport` 自动选 InProcess

### 5.4 接缝四:`TurnDetector`(轮次检测,静音超时 → 语义模型可插拔)

把"判断用户是否说完一轮"抽象成接口,与 VAD(有没有声)、generation 打断(插嘴没)三层各司其职:

```
interface TurnDetector {
  // 输入近期音频/VAD 状态,输出"用户是否说完当前轮"
  onSpeechFrame(frame, vadState)
  onEndOfTurn(cb)              // 判定"说完" → 触发 LLM
  reset()                     // 新一轮开始时复位
}
```

实现:
- `SilenceTimeoutDetector` —— **P1 起步**:沿用静音超时(默认 1.5s),简单、零依赖、先跑通全链路。
- `SmartTurnDetector` —— **P2/P3 引入**:接 Smart Turn(BSD-2,23 语言,本地 ONNX ~12ms CPU,树莓派可跑),按声学/语义判断"说完没",减少误抢话。

**职责边界(防混淆):**
```
VAD(Silero)          → 有没有人在说话(逐帧)
TurnDetector          → 用户说完没,该不该接话   ← 本接缝替换的就是这一步
generation 计数+flush → AI 说话时被插嘴 → 打断(§3,完全独立,不受影响)
```

切换 `SilenceTimeoutDetector ↔ SmartTurnDetector` 只改 config + 实现选择,管线其余不动;两者可 A/B 实测(延迟、误打断率)后再定默认。

### 5.5 接缝五:`TurnStrategy`(应答策略,单次流式 → Agent loop 可插拔)

把"拿到用户输入后**如何产出回复**"抽象成接口,坐在 `bus`/`processor` 与 `llm/gateway` 之间。这是原稿遗漏的一层。

```
interface TurnStrategy {
  // 输入 + 注入上下文(记忆/人格/工具) + 取消信号 → 流式输出帧
  respond(input, ctx: { memory, personality, tools, signal }): AsyncIterable<Frame>
}
```

实现(渐进式,同 TurnDetector 思路):
- `SingleShotStrategy` —— **P1/P2 起步**:直接流式 LLM,无工具、无多步。低延迟,先跑通。
- `ToolCallingStrategy` / `ReActStrategy` —— **P3+**:多步推理 + 工具调用(查天气/记事/搜索),配合"填充语"遮蔽延迟。

**接口必须内建三条硬约束(否则模块化无意义):**
1. **可打断**:`signal`(AbortSignal/generation)贯穿每一步,barge-in 能穿透到"工具调用进行中"。
2. **流式**:输出是 `AsyncIterable<Frame>`,支持"先流式说思考/填充语,工具返回后再流式说答案"。
3. **延迟感知**:每个慢步骤(工具/多步 LLM)前可触发填充语(参考 eros_ai `voice/filler.py`)。

> ⚠️ YAGNI:P1 只实现 `SingleShotStrategy`,**不要一上来做重 Agent 框架**。`reference/claude-code-haha-main` 的 StreamingToolExecutor 是 P3+ 深入时的精读对象。

### 5.6 自主行为模块 `autonomy/`(后台主动 loop,与回合内 loop 分离)

原设计的"IDLE 主动问候 / 30 分钟后回来打招呼 / 夜间禁言"属于**另一种 loop**:定时器/事件触发、可一键关闭、需节流。**独立成模块**,不与 §5.5 的反应式 loop 混在一起。

```
autonomy/
  trigger.js     # 定时器 + 事件源(IDLE 超时、桌面活动、到点)
  policy.js      # 节流:每天最多 N 次、夜间(23:00-08:00)禁言、不打扰窗口
  initiator.js   # 满足条件时,自发起一次 TurnStrategy(复用 §5.5)
```

- 复用 `TurnStrategy` 产出主动话语,但**发起者是自己而非用户**。
- 默认可通过 config 关闭;P4(演进)再启用。
- **未来深入研究方向**(用户已标注):Agent 后台自主活动 = 这个模块的扩展(自主目标、自发记忆整理、主动关怀)。

### 5.7 模块化验收标准(开发阶段据此把关)

- [ ] 业务核心(`core/`、`personality/`、`memory/`)对 `AudioTransport`、`Provider`、`TurnStrategy` 只依赖接口,grep 不到具体实现的 import
- [ ] 切换"本地单机 ↔ 分离"仅改 config + transport 选择,业务代码 0 改动
- [ ] 新增一个云端 Provider / 端侧 Provider,不改 `llm/gateway` 路由代码
- [ ] 终端模块(`audio/*`)可独立编译/打包,不依赖大脑业务模块
- [ ] generation 标签贯穿 transport,中断语义在进程内与 WebSocket 两种实现下行为一致
- [ ] `SingleShotStrategy → ToolCallingStrategy` 切换不动 bus/voice 管线;barge-in 能中断进行中的工具调用
- [ ] `autonomy/` 可整体关闭,关闭后对反应式对话零影响

---

## 6. 与原 v2.1 开发顺序的衔接

在原 P0–P4 基础上插入"边界"相关工作:

| 阶段 | 新增/调整 |
|------|-----------|
| **P0** | 定义 `AudioTransport` 接口 + `InProcessTransport`;终端/大脑模块目录拆分;**协议 version 字段就位**(见 §7.5) |
| **P1** | 本地单机形态跑通(进程内 transport),VAD 在终端侧模块;`TurnDetector` 接口 + `SilenceTimeoutDetector` 起步;`TurnStrategy` 接口 + `SingleShotStrategy` 起步;**锁定单用户单终端** |
| **P2** | `WebSocketTransport` + 心跳/重连;generation 标签跨网络;终端最小本地资产;接入 `SmartTurnDetector` 与静音超时 A/B;**WSS/TLS + 终端鉴权握手** |
| **P3** | 终端能力声明 + 形态自适应;两条网分治的容错完善;**(备选)`WebRTCTransport`** 视弱网情况引入;`ToolCallingStrategy`(Agent loop)接入 |
| **P4(演进)** | 接入 `gemma4-local` Provider(LiteRT-LM 运行时);手机合体形态验证;启用 `autonomy/` 后台自主 loop |
| **后续大版本** | 多用户/多终端隔离(personality/memory 按 user 归属)——见 §7.6 |

---

## 7. 开源前作对标与方案优化(2026-06-18 调研)

> 完整调研见 `docs/reference-projects-research-2026-06-18.md`。结论:chat-A 的多数自研模块都有成熟前作,部分可直接复用或照搬公式。

### 7.1 被验证站得住的设计

- **配置驱动多 Provider**:Open-LLM-VTuber 用配置切换全部 STT/LLM/TTS,印证本方案。
- **WebSocket 瘦终端**:RealtimeVoiceChat 用纯 WebSocket 实现 ~500ms 端到端,验证 B 方案在简单网络可行。
- **EchoGuard**:Open-LLM-VTuber 的"免耳机模式"(AI 忽略自己声音)与本设计 §3 回声处理同思路。
- **OCEAN 人格 + 冷启动 + delta 演化**:**未找到任何开源前作 → 这是 chat-A 真正的差异化点,自研合理。**

### 7.2 建议采纳的优化

| 优化点 | 现方案 | 调研建议 | 处理 |
|--------|--------|----------|------|
| **轮次检测** | 纯静音超时(1.5s) | 引入 **Smart Turn**(BSD-2,23 语言,~12ms CPU)做语义"说完没"判断,误打断更少 | 与 generation 计数**并存**:Smart Turn 管"何时应答",generation 管"打断后丢弃旧输出" |
| **记忆系统** | 全自研(衰减+情感共振+混合检索) | **OpenMemory** 已有情感扇区 + 指数衰减公式 `exp(-λ·days/(salience+0.1))` + 混合打分 `0.6×相似+0.2×显著+0.1×新近+0.1×链接`;**mem0** 是 Node 原生底座 | **决定:自研(不引入外部依赖)。** OpenMemory 的衰减/打分公式仅作**设计参考**借鉴,验证 chat-A 自研公式的合理性 |
| **端侧部署栈** | (原写 MediaPipe) | **LiteRT-LM**:跨平台含树莓派、原生音频、有 Gemma E2B 官方 checkpoint | §5.2 演进期改用 LiteRT-LM 作 `gemma4-local` Provider 的运行时 |
| **整体参考** | — | **Open-LLM-VTuber** 是最接近对标,实现前先通读其架构 | 实施前研读 |

### 7.3 需要你拍板的真争议:WebRTC vs WebSocket

调研显示这是**真有争议、取决于网络条件**的决策,不是非黑即白:

- **WebSocket(现方案)**:简单,局域网/PC 下 ~500ms 完全够用(RealtimeVoiceChat 实证)。
- **WebRTC**:抖动/丢包恢复更好;LiveKit/Pipecat 在**嵌入式/移动/弱网**倾向它;有 ESP32/手机端 SDK。但厂商立场需打折看。

**✅ 决定(2026-06-18):WebSocket 起步。** 默认 `WebSocketTransport` 用于 PC/局域网开发。**WebRTC 留档,后续视情况(树莓派/手机走蜂窝弱网、丢包明显)再引入**,届时新增 `WebRTCTransport` 实现即可,业务代码不动——这正是 §5.1 `AudioTransport` 抽象的价值所在。WebRTC 引入时机列入 §6 P3 备选。

### 7.5 协议版本化(嵌入式必须,补强)

终端(树莓派/手机)与大脑**分开部署、各自升级**,"终端固件落后于大脑"是常态。因此 transport 协议从 P0 起就要带版本:
- 握手时双方交换 `protocolVersion`;大脑兼容"当前及前 1 个次版本"。
- 控制信令带 `v` 字段;新增字段只增不改(向后兼容);破坏性变更升主版本并拒绝过旧终端(给明确错误而非静默失败)。
- 音频帧格式(16kHz/Int16/mono)纳入版本约定。

### 7.6 多用户 / 多终端(显式锁定范围)

整套 personality/memory 当前假设**单用户**。"一个大脑接多个终端"一旦成立,会渗透到 schema、召回、注入每一层。
- **决定:P1–P3 锁定单用户单终端**(终端身份仅用于鉴权与重连,不做数据隔离)。
- **多用户/多终端隔离(personality/memory 按 user 归属)= 后续大版本**,届时 memory/personality 表加 `user_id` 维度、召回按 user 过滤。不在当前草案展开。

### 7.7 安全(补强)

调研中 realtime-demo "裸连 + CORS 仅 localhost + 无鉴权"是 demo 局限,生产不可照抄。大脑一旦上局域网/公网:
- **传输加密**:WebSocket 走 **WSS/TLS**。
- **终端鉴权**:连接握手携带 token(预共享密钥 / 设备证书),大脑校验后才建会话。
- **会话隔离**:每连接独立会话上下文(参考 realtime-demo `_Session` 结构,但加鉴权)。
- 列入 §6 **P2** 落地。

---

## 8. 待办 / 未决项

- [x] ~~音频编解码选型~~ → **已定:PCM Int16 / 16kHz / mono 硬约定起步**(realtime-voice-agent-demo 范本,见 `reference-code-findings-2026-06-18.md` §3);Opus 留待带宽优化。
- [ ] WebSocket 协议帧格式细节(音频帧 + 控制信令复用/分帧)——参考 Nexus IPC 的 invoke/event 分离 + requestId(`reference-code-findings` §2.4)。
- [x] ~~WebRTC vs WebSocket 起步选择~~ → **已定:WebSocket 起步,WebRTC 留档待 P3 按需引入**。
- [x] ~~记忆系统:自研 vs 复用~~ → **已定:自研**。算法配方见 `reference-code-findings-2026-06-18.md` §5(本地 Hash256 零依赖向量 + Russell 2D 情感共振 + 双 Pass diff + 三层衰减)。
- [x] ~~轮次检测方案~~ → **已定:渐进式**。P1 `SilenceTimeoutDetector`(静音超时,可参考 realtime-demo 的 600ms),P2/P3 接 `SmartTurnDetector` A/B,见 §5.4。
- [x] ~~向量检索引入时机~~ → **可提前到 P1**:Nexus 本地 Hash256 嵌入零依赖,无需向量 DB。
- [ ] 大脑"保活窗口" N 分钟的具体取值(与 IDLE 60s 的关系)。
- [ ] Gemma 4 license 商用核实(Gemma Terms of Use,非 Apache 2.0)。
- [x] ~~多终端会话/身份隔离~~ → **已定范围:P1–P3 锁单用户单终端,多用户列后续大版本**(§7.6)。
- [x] ~~Agent loop 模块化~~ → **已定:`TurnStrategy` 第5接缝**(§5.5),P1 单次流式起步,P3+ Agent loop;后台自主 loop 独立 `autonomy/`(§5.6)。
- [ ] **canonical 设计指定**:是否以 `real-time-agent-design.md` 为骨架(待用户拍板,见文首)。
- [ ] 协议版本兼容窗口的具体策略(§7.5)在实施计划细化。

> 源码级可复用清单(含 `file:line`)见 **`docs/reference-code-findings-2026-06-18.md`**。

---

*本草案为方向对齐产物,细节(协议字段、接口签名)将在转入实施计划时进一步固化。*
