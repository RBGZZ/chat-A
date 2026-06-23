## Context

`@chat-a/voice-detect` 已具三层接缝(`vad.ts` / `turn-detector.ts` / `endpointing.ts`):
- `VadDetector.pushFrame(frame): VadFrameResult`(**同步**)+ `VadGate` 去抖状态机 + `StubVadDetector`(注入概率序列)。
- `EouModel.predict(window): number`(**同步**)+ `TurnDetector`(组合 EouModel + DynamicEndpointing)+ `StubEouModel`。
- `DynamicEndpointing` / `decideEndpointing`(纯函数,TEN 3 态,per-language 阈值)——**唯一完整实现且重点测试**的部分,本切片不动。

VoiceLoop 在 `#onAudio` 同步调用 `vad.pushFrame(pcm)` 并立即读 `result.event`/`result.speaking`;在 `#shouldEndpoint` 同步调用 `turnDetector.step(...)` 并立即读 `decision.shouldEndpoint`(`packages/runtime/src/voice-loop.ts:176,226`)。这两处签名是**硬约束**:本切片「零改 VoiceLoop」,故真适配器必须维持同步。

桩的现状缺口:`StubVadDetector` 恒按注入序列、`StubEouModel` 同理,`cli-voice.ts:89-92` 用「恒有声 0.9 + 高 EOU 0.9」占位——「免提连续对话」端点检测不真。

参照已落地的真引擎注入纪律:`WhisperLocalStt` 注入 `SpawnFn`、`KokoroTts` 注入 `KokoroSession`、`NodeAudioDevice` 动态 import `naudiodon`——**worktree/CI 不引原生依赖,真引擎运行时注入,测试注入 Fake**。

## Goals / Non-Goals

**Goals:**
- 在 voice-detect 内交付 `SileroVadDetector` / `SmartTurnEouModel` 两个真适配器,实现既有 `VadDetector`/`EouModel` 接口,经**同步**推理端口注入。
- 复用既有 `VadGate`(去抖)与 `DynamicEndpointing`(策略),不重复实现。
- 窗口/采样率/窗时长全部进 `config.ts`;失败优雅降级;确定性 Fake + 测试,CI 绿。
- 零改 VoiceLoop / Conversation / 总线 / 现有 endpointing 逻辑。

**Non-Goals:**
- 不写 onnxruntime / sherpa-onnx 进 CI 依赖图;不在本环境跑真模型/真麦克风。
- 不改 `cli-voice.ts` 的装配(真端口注入是后续切片)。
- 不做异步推理重构;不碰附和/打断分类(§4 行 571)。

## Decisions

### D1:推理端口设计为**同步** `infer(samples: Float32Array): number`
- **为何**:VoiceLoop 同步调用 `pushFrame`/`step` 且立即用结果,「零改 VoiceLoop」要求适配器同步。canonical §9 行 324 已指向 **Sherpa-ONNX**,其 Node 原生绑定的 VAD 推理为**同步阻塞**,天然满足;Silero 单窗(512 样本)RNN 推理 sub-ms 级,纯 CPU。
- **备选**:(a) 改 `pushFrame`/`predict` 为 async —— 破坏「零改 VoiceLoop」与 §4.2 B 层同步消费,否决。(b) 异步推理 + 「返回上一窗结果」流水线 —— 事件 `atMs` 归属错乱、语义复杂,否决。(c) onnxruntime-node(仅异步 `run`)+ worker + `Atomics.wait` 阻塞桥 —— 过度工程,否决;真接入用 sherpa-onnx 同步绑定即可。
- **端口最小面**:入 `Float32Array`、出 `number`、加 `reset()`;不暴露任何原生类型(沿用 `SpawnFn`/`KokoroSession` 纪律)。

### D2:`SileroVadDetector` 负责「帧→窗」缓冲,概率→事件复用 `VadGate`
- 协议帧 = 160 样本/10ms;Silero 习惯窗 = 512 样本/32ms(§5b 行 105)。适配器累积 `Int16` 帧样本 → 转 `Float32`([-1,1]) → 攒满 `windowSamples` 调一次 `infer`;未满窗的 `pushFrame` **复用上一窗概率**跑 `VadGate.step`(不重复推理、不阻塞、维持逐帧事件节奏)。
- **为何复用 VadGate**:去抖(`speechStartFrames`/`speechEndFrames`)已实现且被测;真桩共用同一状态机保证「真适配器与桩同语义」,契约测试可迁移。
- `reset()`:清样本缓冲 + `VadGate.reset()` + 端口 `reset()`(Silero RNN 隐状态)。

### D3:`SmartTurnEouModel` 拼音频窗 + 截最近窗,概率交 `DynamicEndpointing`
- `predict(window: PcmFrame[])`:拼 `Int16`→`Float32`,**仅取最近不超过 `maxWindowMs`** 的尾段(防累积窗无界增长、贴 Smart-Turn 定长输入习惯),`infer` 得 finished 概率返回。空窗返回 0、不推理。
- 概率不在本类做任何阈值判断 —— 原样回 `TurnDetector`/`DynamicEndpointing`(TEN 3 态、per-language、EMA 自校准全复用)。

### D4:配置外置 + 降级
- `config.ts` 增 `DEFAULT_VAD_INFERENCE`(`windowSamples=512`、`sampleRate=16000`)与 `DEFAULT_EOU_INFERENCE`(`maxWindowMs`、`sampleRate=16000`、归一化开关)。构造可整表覆盖。
- 降级:`infer` 抛错 → VAD 视该窗概率 0(不误触发 start)、EOU 视作 0(未说完);吞错不向上抛(VoiceLoop catch 是最后兜底)。

### D5:真引擎接入只文档化,不进 CI
- 真 Silero / Smart-Turn v3 经 sherpa-onnx 同步绑定包成 `VadInferenceSession`/`EouInferenceSession` 注入,**手测**;若后续要可运行的真工厂,照 `NodeAudioDevice` 动态 import + 鸭子类型另起切片。本切片交付:接口 + 真适配器 + Fake + 测试 + 接入说明(文件头注释)。

## Risks / Trade-offs

- **[真模型在真硬件的延迟/精度未标定]** → 本切片只固定接缝形状(同步/单窗/可降级);真值留 PC/Pi 手测标定(config 可热调),不进 CI。
- **[同步端口把真接入绑定到 sherpa-onnx 类同步绑定]** → 可接受:契合 canonical 量化方向;若将来必须用纯异步运行时,再单独评估 worker 阻塞桥,不在本切片背负。
- **[「帧→窗」缓冲带来最多 1 窗(~32ms)的概率滞后]** → VAD 概率以窗为粒度更新、帧间复用上一窗值;对 §3.2 延迟预算影响极小且可由窗口 config 调,接受。
- **[EOU 截最近窗可能丢更早语境]** → Smart-Turn 本就定长音频窗判韵律(非全程转写),最近窗足够;`maxWindowMs` 可调。
- **[Fake 测不到真原生行为]** → 明示:Fake 只验缓冲/窗口/降级/复位逻辑;真模型/音频行为 headless 跑不了,手测覆盖(沿用 whisper/kokoro 验收边界)。

## Migration Plan

1. 新增配置 + 两个真适配器 + Fake + 导出,Fake 驱动测试,`voice-detect` typecheck+test 绿;全仓 typecheck+test 绿(零改其它包)。
2. 后续切片:`cli-voice.ts` 按 env 注入真端口(sherpa-onnx 同步绑定),PC 手测真发声端点检测;桩保留作 CI/冒烟默认。
- **回滚**:适配器与桩同接口,注入点改回桩即回滚,无数据/schema 影响。

## Open Questions

- Silero v5 推理窗到底 512 还是 256/可变?——默认 512(§5b 行 105),真接入按所选模型/sherpa 版本核对,config 可改。
- Smart-Turn v3 期望的归一化/窗长具体值?——先占位(`maxWindowMs` 合理默认),真接入按模型卡标定。
- 真工厂(sherpa-onnx 动态 import)是否本切片就给一个 optional 模块?——倾向**不**,留后续切片(本切片专注 CI 可测的接缝 + 适配器,贴 whisper/kokoro 的交付边界)。
