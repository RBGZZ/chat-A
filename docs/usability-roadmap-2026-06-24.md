# chat-A 可用性 Roadmap — 距离"全可用语音陪伴"还该做什么(2026-06-24)

> 状态:**研究/规划文档**(非权威设计)。权威设计仍是 `docs/chat-a-canonical-design.md`(Canonical v1.0)。
> 本文回答一个问题:**离"真·实时语音对话陪伴可用"还差哪些、按什么优先级做。**
> 方法:只读通读 `packages/` + `openspec/changes/archive/` 代码现状 + WebSearch 调研难点。每条结论标注来源:**【代码核实】**(读过源码)/ **【调研推断】**(WebSearch + 设计文档推断)。

---

## 0. 现状一句话

**文字陪伴与"填 key 即测"的云语音单向链路(文本→云 LLM→云 TTS→WAV)已真网络跑通;真免提连续语音对话(真麦克风/扬声器 + 打断 + AEC + 真 STT 闭环)是当前最大的、尚未验证的缺口。** 架构与接缝高度成熟(12 个包、56 个已归档切片、1214 测试绿),"未做"的几乎都是"接真硬件/真网络/调参",而非"重写架构"。

### 已验证清单(真网络/真跑通)【代码核实】

| 能力 | 状态 | 证据 |
|------|------|------|
| 文字对话(REPL,流式 + 斜杠命令 + 优雅降级) | ✅ 真跑通 | `packages/client/src/cli.ts` |
| Qwen 文本 LLM(DashScope,OpenAI 兼容流式) | ✅ 真网络 | `openai-compat-llm.ts` + `registry.ts`,`smoke:qwen` |
| Qwen TTS realtime(WebSocket,24kHz PCM 流式) | ✅ 真网络 | `qwen-tts-realtime.ts`,`scripts/qwen-smoke.ts` |
| 「填 key 即测」单向语音链路(文本→LLM→TTS→`out.wav`) | ✅ 真网络 | `scripts/voice-text-to-wav.ts`(`pnpm test:voice`) |
| Anthropic Claude LLM | ✅ 真网络 | `anthropic-llm.ts` |
| WebSocket 网关(跨网音频 + 心跳/重连 + 跨网打断) | ✅ 真网络 | `gateway/`,archive `websocket-gateway-transport` |
| 长期记忆(SQLite 真相源 + 关键词/语义召回 + 反思/巩固) | ✅ 代码就位 | `packages/memory/` |
| 人格 OCEAN+PAD+立场/自我概念演化 + closeness | ✅ 代码就位 | `packages/persona/` |
| 后台主动性引擎(调度/仲裁/预算/决策 LLM,默认关) | ✅ 代码就位 | `packages/autonomy/` |
| 感知 + MCP client + 内置动作(默认关) | ✅ 代码就位 | `packages/interaction/` |
| 夜间巩固流水线(默认关) | ✅ 代码就位 | `memory/src/consolidation.ts` |
| 可观测(OTel + SQLite 决策 trace + 回放查看器) | ✅ 代码就位 | `packages/observability/` |
| EchoGuard 软门控(说话时抬高 barge-in 确认门槛,默认关) | ✅ 代码就位(非真 AEC) | `voice-detect/src/echo-guard.ts` |

### 仍缺 / 代码就位未验 / 需新建

| 能力 | 分类 | 状态 | 落点 |
|------|------|------|------|
| 真麦克风/扬声器(naudiodon,需 MSVC/PortAudio) | 需真机+原生依赖 | **未验**(动态加载,装不上明确报错) | `client/src/audio/node-audio-device.ts` |
| 真 STT 闭环(qwen-asr / qwen3-asr-flash-realtime) | 需真网络 | 代码就位**未验** | `openai-compat-stt.ts`,`stt-config.ts` |
| omni audio-in(path B,真音频) | 需真网络 | 代码就位**未验** | `qwen-omni-llm.ts` |
| Silero VAD / Sherpa EOU(ONNX 真推理) | 需原生依赖 | 接缝就位,需运行时注入 | `voice-detect/src/{silero-vad,smart-turn-eou}.ts` |
| 真 AEC(回声消除,自适应滤波) | 需新建/原生 | **无代码**(只有软门控) | — |
| 真机 E2E 延迟/打断手感调优(TTFA、阈值自校准) | 需真机 | **未做** | runtime VoiceLoop |
| prosody 从语音读情绪 → PAD | 需真网络+新建 | **未真正实装**(§7#5) | 拟接 qwen-asr emotion 字段 |
| Kokoro / Edge-TTS / Whisper-local 本地 Provider | 需原生依赖 | 接缝就位(部分占位报错) | `providers/src/*` |
| 树莓派量化部署 | 需真机 | **未做**(全为估算) | — |

---

## 1. 离"可用"还差哪些(分类盘点)

### A. 纯代码可做(无需真机/真网络,本 worktree 即可推进)
1. **prosody → PAD 接线**:qwen3-asr-flash-realtime 的转写事件**自带说话人情绪**(surprised/neutral/happy/sad/disgusted/angry/fearful)【调研推断,见 §3.4】——把它映射进人格 PAD 是纯代码工作(STT 事件已有 emotion 字段时)。可先在 mock/fixture 上写 golden test。
2. **EchoGuard → "agent 说话时硬门控 STT"升级**:现状是"抬高确认门槛"的软方案;升级为"agent 说话期间完全不向 STT/LLM 送麦克风音频 + 收尾 1.5s 冷却窗(抬高能量门槛)"是纯状态机改造,行业验证有效(见 §3.1)。可先在 WAV/Fake 设备上写测试。
3. **延迟/打断的自校准框架骨架**:实测 TTFT/TTFA → 动态调 `silenceTimeout` 的逻辑可先写确定性内核 + golden test(真值在真机才能定,但算法可测)。
4. **RMS 双层门控**(§3.1 Tier 2)纯代码:能量阈值门控、冷却窗,可在 WAV 设备上单测。

### B. 需真网络(填 key 即可验,无需原生依赖)
1. **真 STT 闭环验证**:`qwen-asr`(`/audio/transcriptions`,整段)与 `qwen3-asr-flash-realtime`(WebSocket 流式)真接。代码就位,缺真网络冒烟脚本(类比 `smoke:qwen`)。
2. **omni audio-in(path B)真音频验证**:`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`,PCM16/16kHz,事件 `input_audio_buffer.append/commit` + `session.finish`【调研,见 §3.3】。代码就位,缺真音频冒烟。
3. **流式 ASR 的 interim/final 接 EOU**:`...input_audio_transcription.text`(中间)/`.completed`(最终)事件【调研,见 §3.4】接入回合检测。

### C. 需真机 + 原生依赖(MSVC/ONNX/PortAudio,或换方案)
1. **真麦克风/扬声器**:naudiodon 需 MSVC + PortAudio,或换 prebuilt 方案(见 §3.5)。
2. **本地 VAD/EOU 真推理**:Silero VAD / Sherpa Smart-Turn,需 onnxruntime-node。
3. **真 AEC**:见 §3.1。
4. **真机 E2E 延迟/打断调优**:必须在真硬件上听 + 调。
5. **树莓派量化部署**:Llama.cpp GGUF + Kokoro ONNX + Sherpa-ONNX,目标 ~1.2GB 纯 CPU(设计 §5.6,全为估算)。

---

## 2. 分阶段优先级里程碑

> 工作量为粗估(开发人日级别);"分类"= 纯代码 / 需真网络 / 需真机。

### M1 — 文字陪伴打磨 + 真语音 E2E 链路接通(纯代码 + 需真网络)
**目标:把"伴侣感"行为层从代码就位推到真验证;打通"语音入 + 语音出"的云端闭环(无需真麦克风)。**

| 项 | 做什么 | 分类 | 工作量 | 风险 |
|----|--------|------|--------|------|
| M1.1 真 STT 冒烟 | 写 `smoke:asr`(类比 `smoke:qwen`):WAV → qwen-asr → 转写文本,验证真网络 + emotion 字段 | 需真网络 | 0.5–1d | 低(REST,代码就位) |
| M1.2 流式 ASR 接 EOU | qwen3-asr-flash-realtime WS interim/final 接回合检测 + 自校准静默窗骨架 | 需真网络 | 2–3d | 中(WS 事件协议需对齐真实文档) |
| M1.3 prosody→PAD | ASR emotion 字段 → 人格 PAD 拉力(纯代码 + golden test;真值靠 M1.1 验) | 纯代码 | 1–2d | 低 |
| M1.4 行为层真验 | 用 §10 rubric eval 跑反谄媚/会反对/主动跟进/心情连续(autonomy/记忆/人格开启) | 纯代码 | 2–4d | 中(eval 主观) |
| M1.5 STT 失败降级链真测 | ASR 失败 → 纯文本输入;TTS 失败 → 只显示文本(§3.2 优雅降级) | 纯代码 | 1d | 低 |

**M1 出口**:`文本/WAV 输入 → 真云 STT(带情绪)→ 记忆+人格+autonomy → 真云 TTS → WAV/扬声器(下一里程碑)`全链路真网络跑通,行为层有 eval 基线。

### M2 — 文件/半双工语音 E2E + omni 路径验证(需真网络)
**目标:不依赖真麦克风原生依赖,先用 WAV/文件设备 + 浏览器路径验证完整语音回合(含打断逻辑)。**

| 项 | 做什么 | 分类 | 工作量 | 风险 |
|----|--------|------|--------|------|
| M2.1 omni path-B 冒烟 | `smoke:omni`:PCM16/16kHz 音频 → omni-realtime WS → 转写+文本流,验证鉴权/事件 | 需真网络 | 1–2d | 中(WS 事件细节) |
| M2.2 双路径降级真测 | omni audio-in 失败 → 降级 STT+LLM+情感补丁(§4 双路径) | 需真网络 | 1–2d | 中 |
| M2.3 EchoGuard 升级为硬门控 | "agent 说话期完全不送 STT + 1.5s 冷却抬阈"(§3.1),WAV 设备上单测 | 纯代码 | 1–2d | 低 |
| M2.4 (可选)浏览器端路径 | Web Audio + `getUserMedia({echoCancellation:true})` 做"零原生依赖"语音前端(浏览器免费给 AEC) | 需真机(浏览器) | 3–5d | 中(新增前端) |

**M2 出口**:云语音回合在文件/浏览器路径上端到端可跑,打断/门控逻辑经测试,omni 双路径验证。

### M3 — 真麦克风免提连续对话(需真机 + 原生依赖)⭐ 最难、最关键
**目标:真硬件上"免提、连续、可打断、不自己打断自己"的语音对话——这是"陪伴"体感的真正门槛。**

| 项 | 做什么 | 分类 | 工作量 | 风险 |
|----|--------|------|--------|------|
| M3.1 音频 I/O 落地 | 装通 naudiodon(MSVC)**或**换 prebuilt 方案(§3.5);真麦克风采集 16kHz + 扬声器播放 | 需真机+原生 | 2–4d | **高**(原生依赖 + 平台差异) |
| M3.2 本地 VAD/EOU 真推理 | Silero VAD + Sherpa Smart-Turn 注入 onnxruntime-node,真音频验证 | 需真机+原生 | 2–3d | 中 |
| M3.3 真 AEC / 半双工门控 | **推荐先上"硬门控 + RMS 双层"(§3.1),AEC3 WASM 作增强**;真机调阈值 | 需真机 | 3–7d | **高**(免提硬需求) |
| M3.4 E2E 延迟/打断调优 | 实测 TTFA、自校准静默窗、打断手感、误打断率;RMS 日志从 day1 instrument | 需真机 | 3–5d | **高**(只能真机调) |

**M3 出口**:真麦克风/扬声器免提连续对话可用,不自我打断,打断手感自然,延迟可接受。

### M4 — 树莓派/嵌入式部署(需真机 + 量化)
**目标:把 PC 验证过的链路下沉到 Pi 纯 CPU。**

| 项 | 做什么 | 分类 | 工作量 | 风险 |
|----|--------|------|--------|------|
| M4.1 profile gate 接通 | `--target pc\|raspberry` 解析 → Factory 选 device/compute_type(接缝已埋) | 纯代码 | 1–2d | 低 |
| M4.2 本地 TTS(瓶颈) | Kokoro ONNX(~100MB)接通(设计指明 TTS 是嵌入式真瓶颈) | 需真机+原生 | 2–4d | 中 |
| M4.3 本地 STT/LLM | Sherpa-ONNX STT + Llama.cpp GGUF;OpenAI 兼容 Provider 直接接 | 需真机+原生 | 3–5d | 中 |
| M4.4 Pi 延迟实测定阈 | 所有"估算"阈值真机实测后定档(设计反复强调) | 需真机 | 3–5d | 中 |

**M4 出口**:Pi 纯 CPU 跑通本地语音链路(目标 ~1.2GB),延迟阈值真机标定。

---

## 3. 调研点:推荐方案 + 备选 + 出处

### 3.1 AEC 回声消除(真免提硬需求)
**推荐:分层策略——先做"agent 说话时硬门控 STT + RMS 双层冷却",再按需叠加 WebRTC AEC3。**

行业一致结论:服务端/WebSocket 路径下,**浏览器/原生 AEC 拿不到经 WebSocket 传输的播放音频做参考**,所以纯靠 AEC 不够,**必须有 server 侧"agent 说话状态门控"**。GoNoGo 的生产做法(实测有效):
- **Tier 1 硬门控**:服务端跟踪 agent speaking 状态下发客户端;agent 说话期间**完全不把麦克风音频送给模型**。
- **Tier 2 冷却窗**:agent 说完后 **1.5s 冷却窗**用更高 RMS 门槛(如 0.03 vs 平时 0.05),吸收房间混响衰减,同时允许用户立刻回话。
- 阈值**经验调参**,**day1 就 instrument RMS 日志**("看不见就调不动")。

这正是 chat-A 设计文档 §4 已锚定的"agent 说话时门控 STT"+ EchoGuard 软门控的工程化升级路径——**与权威设计一致**,且现有 `echo-guard.ts` 已是这条路的起点。

**真 AEC(增强,非首选)**:
- **WebRTC AEC3**:业界标准(Chrome/Edge 内置),频域分块自适应滤波(PBFDAF),低延迟。可编译为 WASM 在 Node/浏览器跑;但 **Node 无成熟现成 npm 绑定**(`node-webrtc` issue #638 长期未解)。
- **Speex AEC**:更轻、只衰减不强消,SNR 较高时够用。
- **RNNoise**:**只是降噪不是 AEC**,且 Mozilla 已停维护(2026)——开 AEC 才防啸叫。

**取舍**:真免提先用门控+RMS(纯代码/低风险/设计已对齐),AEC3 WASM 作锦上添花;Pi 上门控方案更现实(无 AEC3 ARM 优化负担)。
来源:[GoNoGo 实测](https://gonogo.team/blog/voice-ai-sub-500ms-latency-echo-cancellation)、[SIMBA Voice AEC](https://simbavoice.ai/resources/echo-cancellation-in-real-time-voice-ai)、[Switchboard AEC3 原理](https://switchboard.audio/hub/how-webrtc-aec3-works/)、[node-webrtc #638](https://github.com/node-webrtc/node-webrtc/issues/638)、[CallSphere 2026 噪声抑制](https://callsphere.ai/blog/vw5e-webrtc-ai-noise-suppression-krisp-rnnoise-patterns-2026)。

### 3.2 实时语音延迟调优(TTFA / 打断手感 / 阈值自校准)
**推荐:沿用设计 §4 已规划的自校准 + 预测性生成,落地优先级如下。**
- **TTFA 基准**:头部 TTS 流式 TTFA ~90ms(Cartesia Sonic 3);Qwen TTS WS 流式已就位,真机测 TTFA 后定预算。
- **回合检测**:行业默认 **STT endpointing 最稳**;model-based(Smart-Turn)延迟更低但需模型;**纯 VAD 延迟偏高**。LiveKit Agents v1.5 已默认 **dynamic endpointing + preemptive generation**(86% 精度/100% 召回的自适应打断)——chat-A 设计 §4 已对齐(EOU 概率驱动动态 endpointing + 预测性生成),只待落地。
- **打断 = 策略非单开关**:何时停 agent / 何时当 backchannel / 何时当噪声忽略 + **记录证据供 QA 回放**(chat-A 已有 SQLite 决策 trace,天然支持)。
- **自校准静默窗**:`silenceTimeout=max(modelPause, measured+overhead)`,实测 TTFT/TTFA 反馈调整(设计 §4)。
来源:[LiveKit 回合检测](https://livekit.com/blog/turn-detection-voice-agents-vad-endpointing-model-based-detection)、[Hamming 打断 runbook](https://hamming.ai/resources/voice-agent-interruption-handling-runbook)、[CallSphere barge-in 2026](https://callsphere.ai/blog/vw7d-voice-agent-barge-in-turn-taking-2026)。

### 3.3 omni audio-in(path B)真接入要点
**鉴权/事件(DashScope Qwen-Omni-Realtime)**【调研】:
- URL:`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime?model=qwen3.5-omni-...realtime`(国际)/ `wss://dashscope.aliyuncs.com/...`(北京)。
- 鉴权:`Authorization: Bearer <API_KEY>` 头。
- 输入:**PCM16 / 16kHz / mono**,`input_audio_format="pcm"`,`sample_rate=16000`。
- 事件流:`session.update`(配置 modalities/voice/instructions)→ 持续 `input_audio_buffer.append` → (手动模式)`input_audio_buffer.commit` → `session.finish` → 收到 `session.finished` 关连接。
- 单会话最长 **120 分钟**;SDK 需 ≥ 2.22.5(若用官方 SDK)。chat-A 已有 `qwen-omni-llm.ts` 代码,缺真音频冒烟。
来源:[Qwen-Omni-Realtime 文档](https://www.alibabacloud.com/help/en/model-studio/realtime)、[apidog Qwen omni 指南](https://apidog.com/blog/how-to-use-qwen-3-5-omni/)。

### 3.4 prosody 情绪 → 人格 PAD
**推荐:直接用 qwen3-asr-flash-realtime 自带的说话人情绪,免自建 prosody 模型。**【调研】
- qwen3-asr-flash-realtime **每次转写都返回说话人情绪**(surprised/neutral/happy/sad/disgusted/angry/fearful),**无需额外配置**。
- 落地:STT 转写事件的 emotion → 映射到 PAD 拉力(类比设计 §6 OCC→PAD),作 §7#5"从语音读情绪"的低成本实装。omni-realtime ASR 同样有 emotion 输出。
- **取舍**:这把"自建 prosody 声学情绪模型"变成"消费云端已有字段",几乎零额外成本,但绑定 Qwen ASR;若换 STT Provider 需 emotion 能力声明 + 降级(无 emotion 时跳过 prosody)。
来源:[DashScope 实时语音识别(含 emotion)](https://www.alibabacloud.com/help/en/model-studio/qwen-real-time-speech-recognition)、[实时语音识别用户指南](https://www.alibabacloud.com/help/en/model-studio/real-time-speech-recognition-user-guide)。

### 3.5 音频 I/O 跨平台(naudiodon 需 MSVC 的替代)
**推荐:短期 Windows 开发用 naudiodon(已就位,可降级);为"零原生依赖"再补一条浏览器端路径;采集侧可评估 prebuilt 的 decibri。**
- **naudiodon(现状)**:PortAudio 绑定,需 MSVC/构建工具;chat-A 已动态加载 + 装不上明确报错 + 可降级 Fake/WAV。能播能采,功能全。
- **decibri**(prebuilt,**只采集不播放**):Win11 x64(WASAPI)/macOS arm64(CoreAudio)/Linux x64+arm64(ALSA)均有 prebuilt,**零构建**,16-bit PCM,1k–384kHz。**但已停维护**(转 Rust 重写),且**无播放** → 只能解决"麦克风采集"半边,播放仍需别的方案。
- **浏览器端路径(强推作为第二条腿)**:Web Audio + `getUserMedia({echoCancellation:true})` → **浏览器免费给 AEC + 麦克风 + 扬声器**,零原生依赖,跨平台,正好对接设计 §3 接缝 1(WebSocket transport)+ §6.4 Live2D 可视化前端。代价是新增前端工程。
- **Pi/Linux**:ALSA(decibri 采集 / 或 PortAudio),配合本地 Kokoro/Sherpa。
- **取舍建议**:PC 开发期 naudiodon 够用(已就位);要"发给用户零折腾"则**浏览器前端**性价比最高(还白嫖 AEC);decibri 仅在"必须 Node 原生采集且不想装 MSVC"时作采集侧候选,需自己补播放。
来源:[decibri(prebuilt)](https://github.com/analyticsinmotion/decibri/tree/main)、[naudiodon](https://github.com/Streampunk/naudiodon)、[getStream WebRTC AI 语音](https://getstream.io/blog/webrtc-ai-voice-video/)。

### 3.6 云 STT 选型(qwen3-asr 真接 + 实时流式)
**推荐:实时对话用 qwen3-asr-flash-realtime(WS 流式 + 自带情绪);整段/兜底用 qwen-asr REST。**【调研 + 代码核实】
- **qwen3-asr-flash-realtime**(WS):`wss://dashscope[-intl].aliyuncs.com/api-ws/v1/realtime`;PCM/16kHz/mono;interim = `conversation.item.input_audio_transcription.text`,final = `...completed`;**自动语种检测 + 说话人情绪**(见 §3.4)。最契合实时陪伴。
- **qwen-asr / qwen3-asr-flash**(REST `/audio/transcriptions`,OpenAI 兼容):chat-A 已有 `openai-compat-stt.ts` 接;适合整段/兜底/文件。
- **备选**:OpenAI 兼容自托管 Whisper(已就位接缝)、Deepgram(多语种流式,设计 §4.1 提及)。
- **取舍**:实时流式 = qwen3-asr-flash-realtime(延迟 + 情绪一举两得);chat-A 现有 REST 路径先验证可用性,流式作 M1.2 升级。
来源:[Qwen 实时语音识别](https://www.alibabacloud.com/help/en/model-studio/qwen-real-time-speech-recognition)、[Qwen-ASR API 参考](https://www.alibabacloud.com/help/en/model-studio/qwen-asr-api-reference)、[Qwen3-ASR-Toolkit](https://github.com/QwenLM/Qwen3-ASR-Toolkit)。

---

## 4. 现在最该做的 3 件事

> 取舍逻辑:**先把"零原生依赖就能验证"的真网络闭环跑通(高价值/低风险),再啃真硬件(高价值/高风险),行为层 eval 并行。**

### 第 1 件:打通真 STT + prosody 的云端闭环(M1.1–M1.3,需真网络,~3–5d)
写 `smoke:asr` / `smoke:omni` 冒烟脚本(类比已验证的 `smoke:qwen`),把 **qwen3-asr-flash-realtime(WS 流式 + 自带情绪)** 真接通,emotion 字段映射进 PAD。**理由**:这是"语音入"唯一未验的一环,且**只需填 key、无原生依赖**;一旦验通,"文本/WAV→真 STT(带情绪)→记忆+人格→真 TTS"全云端闭环成立,prosody(§7#5)顺带低成本实装。**这是当前 ROI 最高的一步。**

### 第 2 件:把 EchoGuard 升级为"硬门控 + RMS 双层冷却",并验证真麦克风免提(M2.3 + M3.1/M3.3,纯代码起步→需真机,~5–10d)
先纯代码把 `echo-guard.ts` 从"软抬阈"升级为 **Tier1 agent 说话期完全不送 STT + Tier2 1.5s 冷却抬 RMS 阈**(行业实测有效、与设计 §4 一致、可在 WAV 设备单测),**day1 instrument RMS 日志**;再上真麦克风(naudiodon 或浏览器路径)真机调阈。**理由**:真免提的"不自己打断自己"是陪伴体感的硬门槛,门控方案**低风险、不依赖难搞的 Node AEC 绑定**,是通往 M3 的关键且最现实的路径。

### 第 3 件:补一条"浏览器端语音前端"作为零原生依赖的第二条腿(M2.4,需真机/浏览器,~3–5d)
Web Audio + `getUserMedia({echoCancellation:true})` 经现有 WebSocket 网关接大脑。**理由**:① **浏览器免费给 AEC + 麦克风 + 扬声器**,绕开 naudiodon 需 MSVC、Node 无成熟 AEC 绑定两大痛点;② 跨平台、对用户"零折腾";③ 正好复用设计接缝 1(WS transport),并为 §6.4 Live2D 可视化铺路。**这是规避"原生音频依赖"风险的最优对冲**,可与第 2 件并行。

---

## 5. 结论可信度标注

- **代码现状(§0 已验证清单 / 缺失表 / 包结构)**:【代码核实】——基于只读通读 `packages/` 与 `openspec/changes/archive/`。
- **AEC 门控方案 / 延迟调优 / 音频 I/O 备选 / STT 选型 / omni 事件 / prosody emotion**:【调研推断】——基于 WebSearch(GoNoGo/LiveKit/Hamming/DashScope 文档等)+ 设计文档交叉印证。DashScope WS 事件名与字段以官方文档为准,真接时需对齐当时 API 版本。
- **工作量/风险估算**:经验粗估,真机/真网络项波动大;Pi 相关阈值设计文档已明确"全为估算,需真机实测"。
