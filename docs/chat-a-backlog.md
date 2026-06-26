# chat-A 待办 Backlog(权威设计缺口清单)

> 本文是**活文档**:由 2026-06-27 对 `chat-a-canonical-design.md`(Canonical v1.0)逐节 vs `packages/` 真实代码的交叉审计生成,只列**未做 / 半成品**项,供跟踪勾选。完成后在此勾掉并同步回 canonical §11。
> 状态口径:`NOT-STARTED`=无代码 / `PARTIAL`=部分落地(接缝或字段在、逻辑缺)。**已 DONE 的不在此列**(主干 P0–P3 大部已落地:记忆/人格/autonomy/MCP/工具调用/可观测性)。
> 优先级信号:canonical §11(line 597)+ 文档索引(line 650)均标 **pVAD v2「转下一步正式实现」**;真机实测头号痛点=barge-in 打不断,根因=缺 AEC。⇒ **Tier A 第一项是设计指定的下一步**。

---

## Tier A · 真机语音收尾(最高优先)

- [ ] **🔴 全双工 v2 pVAD 真打断**(`NOT-STARTED`)——`SpeakerGate` 接缝 + `EnrollmentStore` + `EcapaEmbedder` + `PvadSpeakerGate`;无任何代码。barge-in 真打断唯一正解(缺 AEC,能量门控分不清回声/真插话)。spec `docs/superpowers/specs/2026-06-26-full-duplex-v2-pvad-design.md` 已定稿;**阶段1(SpeakerGate 接缝+fake+VoiceLoop 预门控集成)纯单测可绿,不依赖真麦/真模型**。← 设计指定的下一步
- [ ] **预测性生成 preemptive generation**(`NOT-STARTED`)——STT interim 一变先跑 LLM 不出声 + 输入指纹(transcript+ctx+tools)命中复用;吃掉 LLM 首字延迟的"另一半红利"。护栏:max_retries=3 / max_speech_duration=10s / 默认只投机 LLM 不投机 TTS。
- [ ] **Intent 优先级抢占**(`NOT-STARTED`)——每段输出带 `behavior:queue|interrupt|replace`+`priority`;一个 AbortSignal 串 LLM/TTS/播放,打断零残留。无消息结构。
- [ ] **先 pause 后定夺打断**(`PARTIAL`)——半句写回已有(`INTERRUPT_MARK`,voice-loop.ts);缺 `false_interruption_timeout≈2s`+`resume()`(误打断 2s 内可恢复,而非立即销毁)。
- [ ] **abort 三件套显式化**(`PARTIAL`)——`#abortCurrent`+generation 已覆盖大部;缺显式 per-stage request/finished 握手 + abort_block_event 闸门(abort 进行中冻结新回合启动)。
- [ ] **双向打断闭环**(`PARTIAL`)——`AudioTransport.clearBuffer()` 在;缺"客户端真在播才算打断"的播放游标回传。
- [ ] **EOU 概率驱动动态 endpointing**(`PARTIAL` + 待决策)——`SmartTurnEouDetector`/`DynamicEndpointing` 在,但 **mini ONNX 模型选型未定**(§11:LiveKit turn-detector vs Pipecat Smart Turn v3 vs 自蒸馏)。
- [ ] **双路径多模态 audio-in 为主路**(`PARTIAL`)——`QwenOmniLlm.respondToAudio`/`OmniAudioPort` 在,omni 路已可测但**还非默认/主路**。
- [ ] **桌面输出迁渲染层 Web Audio / 软件 AEC**(`NOT-STARTED`,未来优化)——绕开 naudiodon WASAPI 渲染段错误 + 为软件 AEC 铺路;已有 `IPC.ttsAudio` 路。软件 AEC 在 Electron 实测失效(electron#47043),若做须先 spike。

## Tier B · 行为层"伴侣感"深化(差异化核心)

- [ ] **Agent 自己的内在生活**(`NOT-STARTED`)——内生事件源/兴趣调度("今天我看了点东西很有意思")+ dream 自动写第一人称自传记忆(`subject=agent`);种子在,但"自己的一天"无。
- [ ] **跨会话情绪连续**(`PARTIAL`)——缺 Nexus 三件套:当前情绪持久化 + stateTimeline 历史采样 + affectGuidance 注入每轮。
- [ ] **resolveProactiveLean 情绪→主动倾向**(`NOT-STARTED`)——只在文档,无实现(restraint-first,只在边界微调)。
- [ ] **Inner Thoughts 8 因子动机量表**(`NOT-STARTED`)——决策 LLM"是否值得说"的判断维度(关联/信息缺口/预期影响/紧迫/连贯/原创/平衡/动态),非强制规则。
- [ ] **夜间沉淀 dream daily loop**(`PARTIAL`)——`Reflector`/`LlmReflector` 会话结束反思在;缺**每日 dream 巩固循环** + 整块重写(当前仅 per-record ADD)。

> ✅ 已 DONE(不在清单):反谄媚/会反对(`DissentContributor`)、对话风格纪律、prosody 读情绪、负面姿态 SULKING/WITHDRAWN/COLD、open-thread 主动跟进、三道节流、SkillScheduler+BaseSkill、Arbiter requestSpeak、attention_mode 软反转、给模型沉默工具、每日问候上限。

## Tier C · 多模态 / 可视化(非嵌入式,P3+)

- [ ] **图片生成人物画像**(`NOT-STARTED`)——上传人物图→多模态 `image_input` Provider 分析→预填 §6.2 人格种子;无实现。
- [ ] **Live2D 可视化**(`NOT-STARTED`)——情绪→表情/姿态、TTS→viseme 口型、autonomy→idle_motion;经 §2 可视控制通道下发;无实现。
- [ ] **说话人识别 声纹/diarization**(`NOT-STARTED`)——`voiceprintRef` 字段预留(memory types.ts)但无逻辑;多人对话(单主用户锚定)前置。

## Tier D · 跨切面打磨(小而值得)

- [ ] **profile gate `--target pc|raspberry|browser`**(`PARTIAL`)——`HardwareProfile`/`resolveHardwareDefaults`/`PROFILE_DEFAULTS` 字段就绪,**CLI 未消费**(代码注释自承"不被 cli/profile gate 消费");memory + voice provider 两处同此缺口。
- [ ] **两档注入预算裁剪整合**(`PARTIAL`)——core/peripheral tier 字段在(cognition/prompt/contributors.ts),但 assembler 除"绝不丢 core system fragment"外未按 tier 做预算截断。
- [ ] **交互旋钮 `per_capability` 热切**(`PARTIAL`)——`attention_mode` 全局已做(runtime/attention.ts),`per_capability:{game:focus}` 进某能力热切覆盖未做(标"MVP 仅全局")。
- [ ] **PersonaCard `bindings` 字段**(`PARTIAL`)——ocean/dials/identity/greetings 都在(persona/types.ts),缺 `{llm,tts,embed}` 绑定。
- [ ] **终端能力声明 接缝3 gate**(`PARTIAL`)——接缝预留,MVP 单用户未实际按算力门控可视通道/动作。

## Tier E · 待决策项(§11,先定方向再写代码)

- [ ] 大脑保活窗口 N 分钟取值(tick 间隔 `CHAT_A_AUTONOMY_TICK_MS` 已可配,保活窗口时长待定)。
- [ ] Gemma 4 license 商用核实(P4 端侧 LLM `gemma4-local` 前置)。
- [ ] 人格/边界**用户配置项**设计(旋钮代码已 DONE;缺"关系深度/是否启用最小危机底线"的配置 schema + UX)。
- [ ] MCP 能力进程清单(MCP client/CapabilityRegistry/ProcessSupervisor 已 DONE;缺"首批接哪些外部能力"清单 + stdio vs HTTP 传输选择)。

---

## 总览

约 ~30 个缺口。真正核心 `NOT-STARTED`:**Tier A**(pVAD v2 / 预测生成 / Intent 抢占)、**Tier B**(内在生活 / proactiveLean / Inner-Thoughts 量表)、**Tier C**(图片画像 / Live2D / 声纹)。设计自己的指针 + 真机头号痛点都指向 **Tier A 第一项 pVAD v2 阶段1**。

> 维护约定:完成一项 → 此处勾掉 + 同步 canonical §11 状态标记。新发现缺口追加到对应 Tier。
