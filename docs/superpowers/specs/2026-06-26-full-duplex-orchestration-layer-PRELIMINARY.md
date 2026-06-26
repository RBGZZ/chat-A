# 全双工式编排层 — 初步设计草稿（PRELIMINARY / 挂起）

- 日期：2026-06-26
- 状态：**初步草稿（brainstorm 产物），未定稿、未进实现**。
- **前置条件**：待「音频设备选择+采样率解耦」切片真机测试通过、语音 I/O 能正常对话后，再据此正式立 spec（写实现计划）。当前重心仍是语音 I/O 真机测试。
- 参考素材（已完整克隆到 `reference/github-projects/full-duplex-refs/`，gitignored）：FireRedChat（+ LiveKit fork 子模块）、agents-js、agents-python、pipecat、unmute。
- 关联记忆/调研：`voice-architecture-options-survey`（三路线选型 + 全双工路线决策）、`voice-device-selection-rate-decoupling-slice`（公共地基切片）。

## 1. 目标与定性

做 **(B) 全双工式交互行为**（持续双向流、说话时仍在听、流式 STT、丝滑让步/打断、附和），**不是 (A) 真模型级全双工**（那需换 Moshi/MiniCPM-o 类模型，另走 `FullDuplexAudioSession` 端口，不在本设计）。

调研已证 (B) 可在回合制后端上用「编排层」做出来（FireRedChat = LiveKit Agents 状态机 + 个性化VAD + 语义EoT 三插件；学术 DuplexCascade 等）。本项目接缝已与之同构。

## 2. 范围决策（brainstorm 拍板）

**首期目标行为（全要，单人场景）**：
1. 智能让步 / 动态端点（EoT）
2. 抑制误打断（目标说话人 VAD，pVAD）
3. 抢先生成（降首字延迟）
4. backchannel（嗯/对啊 附和）

**驱动方式**：turn-taking 的让步/打断/附和积极度**绑定现有 `attention_mode`（focus/balanced/companion）+ 人格 assertiveness 档**（高 assertiveness→更敢抢话、EoT 阈值更低；companion→更爱让步、backchannel 更多）。「人格即配置」一以贯之。

**记录为未来优化（不在首期）**：多人对话介入、强噪声环境。

## 3. 架构（推荐，待正式 spec 时对照 FireRedChat 源码定稿）

**就地升级 VoiceLoop + 抽出可插拔 TurnController**（非另起并列层）。依据：FireRedChat/LiveKit 实证「全双工是回合制的超集」，同一状态机内实现；并列层会得到两套易漂移状态机。
- VoiceLoop：线性四态 → **speak 态下 listen 仍活跃**；退化为「执行器」。
- **TurnController**：纯决策核（输入事件 → 输出指令，无副作用、可单测）。
- VAD/EoT/打断/backchannel 策略走现有 Factory 接缝可插拔（FireRedChat 精髓：骨架固定、智能在插件）。

> 注：(A) 单模型全双工的 `FullDuplexAudioSession` 独立端口（spec 历史 §9 预留）是另一条路，与本「就地升级」不冲突、各用各接缝。

## 4. TurnController 决策模型（心脏）

**输入**：VAD 边沿（pVAD 上线后含「是否主人」）、STT 增量（partial/final）、**EoT 概率 `p_eou`（复用现有 `SmartTurnEouModel`）**、当前态（`is_speaking`/`attention_mode`）。
**输出指令**：`hold(再等 Δ) / commit-turn / interrupt / preempt(预启LLM) / backchannel`。
**核心逻辑（动态让步，FireRedChat 范式）**：
```
final / speech_end 时:
  p = p_eou
  p >= 高阈 → commit-turn（最小延时立即提交）
  p <= 低阈 → hold（疑似没说完，endpointing 延时抬到 max，多等）
  之间      → hold 到 min~max
final 但 EoT 未确认 → preempt（后台预启 LLM；确认即播；被打断按 #gen 丢弃）
speaking 中检出(主人)speech_start → interrupt（沿用现有打断三件套 + 可 resume）
短停顿且非抢话 → 可选 backchannel
```
**复用现成**：① 动态让步底子已在——`SmartTurnEouModel` 已产概率，现 `TurnDetector` 仅二值用它，改成「概率→选 min/max 延时」是小改；② 抢先生成复用 VoiceLoop 已有 `#gen` 代际丢弃；③ 打断复用现有三件套 + Task「omni 失败提示」同期补的 resume 思路。

**数据流**：采集帧 →（持续）VAD+STT →（总线）TurnController →（指令）VoiceLoop 执行器 → TTS（可中途暂停/恢复）。listen 在 speak 期不断流 = 全双工物理前提。

## 5. 可测试性（项目硬原则）

- **TurnController 纯决策核**：喂「事件序列 fixture」(VAD 边沿 + STT 增量 + p_eou + attention_mode) 断言「输出指令序列」，golden test 全覆盖让步/打断/抢先/backchannel，零真模型、确定性。
- **VoiceLoop 并行态**：注入 Fake STT/TTS/VAD，构造「speak 期来上行」场景，断言 listen 不被掐、打断可 resume；复用现有 voice-loop 测试范式。
- **验收指标**（抄 FireRedChat + Full-Duplex-Bench）：barge-in 成功率/误触率、EoT 准确率、首音延迟；四类行为 pause/backchannel/turn-taking/interruption。

## 6. 延迟预算

- 抢先生成是**降**延迟（提前启 LLM）。
- 风险：并行 listen+STT 在 speak 期抢 TTS 的 CPU（嵌入式需实测）。
- TurnController 纯算术、零额外网络跳，不进首音热路径。

## 7. 分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **v1（核心）** | VoiceLoop 升并行态 + 抽 TurnController + EoT 动态让步（复用 SmartTurn 概率）+ 抢先生成，人格/attention 驱动，**STT/级联路** | 语音 I/O 真机测试通过 |
| **v2** | pVAD 目标说话人（含主人音色注册）+ backchannel | v1 + pVAD 模型 |
| **v3** | omni 路对齐 + 多人/强噪声环境 | v2；omni 路待先做多模态资料调研 |

v1 不含 pVAD/backchannel（最难最重两件），先把「让步顺滑 + 抢话不卡 + 首音快」体感最大内核跑通。

## 8. 开放问题（留正式 spec 阶段解决）

1. **pVAD 主人音色注册**（开机录一段？复用已有复刻参考音频？）——v2 单人场景关键前提。
2. **嵌入式可行性**：pVAD ONNX + EoT 在树莓派的算力/延迟（呼应部署目标，可能要轻量化）。
3. **backchannel 触发策略**（何时插/插什么/频率/不和自家 TTS 回声打架）——v2 单独打磨，可能首版砍。
4. **omni 路适配**：v3 前先做「多模态全双工/half-cascade」资料调研（用户已定推后）。
5. 架构落地细节：对照已克隆的 FireRedChat `agents/.../voice/audio_recognition.py`（EoT/让步/抢先生成）、`agent_activity.py`（打断/resume/并发）定稿。

## 9. 为何 omni 路放 v3（决策记录）

omni 路上本编排层「杠杆最少、它自己又自带一部分」：① omni 用云端 `semantic_vad`，已白嫖部分动态让步；② v1 三根杠杆（`p_eou` 概率、STT partial 增量、抢先启 LLM）全是级联路原生，omni 黑盒（只 transcript/text/end）拿不到；③ 级联路是当前在测的路 + FireRedChat 直接蓝本，先验证架构最稳；④ Qwen-Omni 本是半双工，外挂编排能加的全双工行为天花板更低。故先级联路验证、再适配 omni。
