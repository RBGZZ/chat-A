# 全双工 v2：pVAD 真·边听边说 设计（Design v1.0）

- 日期：2026-06-26
- 状态：**设计定稿，挂起待真机实现**（用户拍板：先设计、实现待 v1 真机验收 + 有可用麦）
- 承接：`2026-06-26-full-duplex-orchestration-layer-PRELIMINARY.md`（v2=pVAD 真重叠）、`2026-06-26-full-duplex-v1-backchannel-design.md`（v1 已落地）、`voice-architecture-options-survey`（FireRedChat pVAD 调研）
- 参考源码：`reference/github-projects/full-duplex-refs/FireRedChat/.../fireredchat_pvad`（pvad.onnx + ECAPA，已克隆）

## 1. 背景与目标

v1（backchannel）在 speaking 期**暂停上行**防回声（小雪 TTS 被麦采回→云端 ASR 误转写）。**v2 要 speaking 期也持续听**（真·边听边说），就必须解决回声。三方案中 **pVAD 目标说话人**最优（FireRedChat 的招）：只放行**主人**的声音帧进 ASR，小雪的 TTS（不同说话人）天然被拒——**不需 AEC** 即可边听边说。代价：ONNX pVAD + ECAPA 说话人 embedding + 主人音色注册（PC 优先，树莓派存疑）。

**目标**：引入 pVAD 本地预门控，speaking 期不再暂停、靠 pVAD 拒小雪自己的声，达成真·边听边说 + 更可靠打断。

## 2. 范围决策（brainstorm 拍板）

1. **节奏**：先设计定稿、**实现待真机**（v2 是逐帧 pVAD 重件，本环境测不了真麦；避免造个验证不了的重件）。
2. **回声方案**：pVAD 目标说话人（非 AEC、非纯能量）。
3. **注册**：**显式录一段**（~5-10s）→ ECAPA embedding → 持久化；未注册回落 v1。
4. **收敛**：pVAD 预门控**接管** v1 的 speaking 暂停推流 + backchannel echo-gate（`#bcGateUntilMs` 退役）。

### 非目标
- AEC 声学回声消除（不做）。
- 多人对话/说话人分离（v2 单主人；多人见 §5.3b，另立）。
- 树莓派 pVAD 实时（PC 优先；Pi 走 lite profile 降级回 v1）。
- 真 ONNX 推理代码（本 spec 不写；阶段 3 待真机 + 模型权重）。

## 3. 接缝与组件

### 3.1 `SpeakerGate` 端口（packages/voice-detect，与 `VadDetector` 平级）
```ts
export interface SpeakerGate {
  /** 逐帧判「是不是主人在说」：isTargetSpeaker=放行进 ASR;prob=pVAD 概率(供 trace/阈值)。 */
  pushFrame(frame: PcmFrame): { readonly isTargetSpeaker: boolean; readonly prob: number };
  reset(): void;
}
```
- 可注入、fake 可测（与 `VadDetector`/`StreamingSttPort` 等接缝同范式）。

### 3.2 `PvadSpeakerGate`（实现，**阶段 3 待真机**）
- ONNX pVAD（FireRedChat `pvad.onnx`）：causal 流式，10ms/160 样本窗，内部 mel(1,80,15) + gru(2,1,256) buffer 跨窗携带状态（严格时序）；输入特征拼**主人 ECAPA embedding**（spkemb 条件）；`activation_threshold` 默认 0.5。
- 运行时：接现有 sherpa-onnx 会话工厂（若支持自定义模型）或 `onnxruntime-node`（实现期定，注入式，惰性加载，装不上→明确报错由装配回落 v1）。

### 3.3 `EcapaEmbedder`（实现，**阶段 3 待真机**）
- ECAPA-VoxCeleb ONNX：注册音频(~5-10s/16k) → 192 维 embedding（一次性，非热路径）。

### 3.4 `EnrollmentStore`（实现，阶段 2）
- 持久化主人 embedding（复用现有 SQLite，新表 `speaker_enrollment(id, embedding_json, created_at)` 或并入 persona store）。读：装配时取 embedding 注入 PvadSpeakerGate；无记录 → 不启用 pVAD。

## 4. 主人注册流程（显式录一段）

- 首次/设置面板「念一句话」→ 录 ~5-10s @16k/mono → `EcapaEmbedder` 算 embedding → 存 `EnrollmentStore`，可重录覆盖。
- **desktop**：设置面板加「录入我的声音」按钮（IPC：渲染层录音 → 主进程算 embedding → 存；进度/结果回显）。
- **CLI**：启动引导或 `/enroll` 命令（录一段 WAV → embedding → 存）。
- 未注册 → pVAD 不启用 → 回落 v1（speaking 暂停 + EchoGuard）。

## 5. VoiceLoop 集成（pVAD 预门控，subsume v1 回声处理）

- `VoiceLoopDeps` 增可选 `speakerGate?: SpeakerGate`（纯加法；不注入 → 逐字现状 = v1）。仅 stt-stream 路 + 注入时启用。
- stt-stream `#onAudio` 推流分支：每帧先 `speakerGate.pushFrame(pcm)` → **仅 `isTargetSpeaker` 才 `pushAudio`** 给云端 ASR。
- **去掉 speaking 期暂停推流 + backchannel `#bcGateUntilMs` 门控**（注入 speakerGate 时）：speaking 期小雪自己的声/附和 clip 被 pVAD 拒，主人插话被放行 → 云端转写 → 驱动打断/重叠（真·边听边说）。
- pVAD 接管：① backchannel echo-gate（pVAD 拒附和声，时刻门控退役）；② barge-in 升级为说话人维度（比能量 VAD 可靠）。EchoGuard 保留作能量去抖兜底。
- **可追溯**：`VoiceTraceEvent` 加 `speaker-gate`（`isTargetSpeaker`/`prob`），接已落地的 `CHAT_A_VOICE_TRACE` —— 真机调 pVAD 时直接看每帧「是否判主人」。

## 6. 错误处理与降级（§3.2）

- 未注册 / pVAD 或 ECAPA 模型加载失败 / speakerGate 未注入 → **回落 v1**（speaking 暂停 + EchoGuard + 时刻门控），逐字现状，绝不崩。
- pVAD `pushFrame` 抛错 → 视作放行（fail-open，宁可漏过也不卡死对话）+ trace 记，绝不打断采集。
- 注册录音/embedding 失败 → 明确中文提示，pVAD 不启用，主对话不受影响。

## 7. 嵌入式

pVAD + ECAPA ONNX，**PC 优先**；树莓派算力/实时性存疑（survey 标注）。`--target raspberry` lite profile：speakerGate 不注入 → 回落 v1。pVAD 逐帧推理（10ms 窗）的 Pi 可行性留实现期实测。

## 8. 测试（纯函数 + 注入，不靠真模型）

- **`SpeakerGate` fake 注入**：脚本化 `isTargetSpeaker` → VoiceLoop 集成测：主人帧 → pushAudio；小雪帧（fake 判非主人）→ 被拒不推；speaking 期主人插话（fake 判主人）→ 打断；未注入 speakerGate → 回落 v1（speaking 暂停，逐字现状）。
- **`EnrollmentStore`**（阶段 2）：embedding 存取 round-trip、无记录返回 undefined、SQLite 自吞降级。
- **`VoiceTraceEvent.speaker-gate`**：format + emit 测。
- **真 `PvadSpeakerGate`/`EcapaEmbedder` ONNX**（阶段 3）：注入会话工厂（同 sherpa 范式）做确定性壳测；真模型效果/边听边说体感**待真机端到端验**。

## 9. 分期（实现期，待真机）

| 阶段 | 内容 | 可测性 |
|---|---|---|
| **1** | `SpeakerGate` 接缝 + fake + VoiceLoop pVAD 预门控集成（去 speaking 暂停/echo-gate 改 pVAD 路）+ VoiceTraceEvent speaker-gate | **全可单测,不需真模型/真麦** |
| **2** | `EnrollmentStore` + 注册 UX（desktop 按钮 / CLI 命令） | 存取可测;UX 真机 |
| **3** | 真 `PvadSpeakerGate` / `EcapaEmbedder` ONNX 接入（FireRedChat 模型权重 + 运行时） | 壳可测;**端到端待真机+模型** |

> 阶段 1 即便没真模型也能落地（fake SpeakerGate 验证集成正确）；阶段 3 才需真机 + 下载 FireRedChat pvad/ECAPA 权重。

## 10. 主要改动文件（实现期）

- 新增：`packages/voice-detect/src/speaker-gate.ts`（`SpeakerGate` 接缝 + fake）、`pvad-speaker-gate.ts`（阶段3）、`ecapa-embedder.ts`（阶段3）
- 新增：`packages/memory` 或 observability/persona 的 `EnrollmentStore`（embedding 持久化）
- 改：`packages/runtime/src/voice-loop.ts`（`speakerGate?` + stt-stream 预门控 + 收敛 v1 门控 + `speaker-gate` trace emit）
- 改：`packages/protocol/src/voice-trace.ts`（加 `speaker-gate` kind）
- 改：`packages/client/src/cli-voice.ts`（装配 speakerGate + 读 EnrollmentStore + 注册命令）；desktop 设置面板「录入我的声音」
- 测试：各对应

## 11. 开放项

- pVAD/ECAPA 运行时：sherpa-onnx 自定义模型 vs onnxruntime-node（实现期定）。
- pVAD `activation_threshold` / 主人 vs 小雪 区分度（真机标定；若主人把小雪复刻成自己的声→ pVAD 无法区分，属异常设置，提示规避）。
- 树莓派 pVAD 逐帧实时可行性（实测）。
- 真·重叠的回合语义：speaking 期主人插话 → 立即打断 vs 记录重叠（v2 首版按打断；更细的「边说边附和」留后续）。
