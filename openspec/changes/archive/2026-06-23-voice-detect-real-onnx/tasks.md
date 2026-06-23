## 1. 配置外置(config.ts)

- [x] 1.1 在 `config.ts` 增 `VadInferenceConfig`(`windowSamples`、`sampleRate`)+ `DEFAULT_VAD_INFERENCE`(512 / 16000),含中文注释标注 §5b 行 105 来源
- [x] 1.2 在 `config.ts` 增 `EouInferenceConfig`(`maxWindowMs`、`sampleRate`、归一化开关/参数)+ `DEFAULT_EOU_INFERENCE`,注释标注 §5b 行 100 与「截最近窗」理由

## 2. 同步推理端口契约

- [x] 2.1 定义 `VadInferenceSession` 接口(`infer(samples: Float32Array): number` + `reset()`),头注释标注「不暴露原生类型 + sherpa-onnx 同步绑定接入」
- [x] 2.2 定义 `EouInferenceSession` 接口(`infer(samples: Float32Array): number` + `reset()`),头注释同上
- [x] 2.3 提供 `FakeVadInferenceSession` / `FakeEouInferenceSession`(注入概率序列,确定性,记录 infer 调用次数供断言)

## 3. SileroVadDetector(实现 VadDetector)

- [x] 3.1 实现「Int16 帧 → 累积 → 满 `windowSamples` → 转 Float32([-1,1]) → infer」缓冲;未满窗复用上一窗概率
- [x] 3.2 概率喂既有 `VadGate.step` 产出 `speech_start/end`(复用,不重写去抖)
- [x] 3.3 `infer` 抛错 → 该窗概率按 0(优雅降级,不向上抛)
- [x] 3.4 `reset()`:清样本缓冲 + `VadGate.reset()` + 端口 `reset()`

## 4. SmartTurnEouModel(实现 EouModel)

- [x] 4.1 `predict`:拼 `PcmFrame[]` → Float32,截取最近不超过 `maxWindowMs` 尾段 → infer 得概率
- [x] 4.2 空窗返回 0 且不调用 infer;`infer` 抛错返回 0(优雅降级)
- [x] 4.3 `reset()` 调端口 `reset()`;概率原样返回交 `DynamicEndpointing`(不在本类做阈值)

## 5. 导出与接入说明

- [x] 5.1 `index.ts` 导出新接口/适配器/Fake
- [x] 5.2 在 `vad.ts`/`turn-detector.ts`(或新文件)头注释更新真引擎接入路径(sherpa-onnx 同步绑定注入,零改 VoiceLoop)

## 6. 测试与验收

- [x] 6.1 `silero-vad` 测试:满窗推理次数、未满窗复用、去抖产出与 `StubVadDetector` 同语义、reset、降级(注入抛错 Fake)
- [x] 6.2 `smart-turn-eou` 测试:窗截取、空窗返回 0、概率经 `TurnDetector`/`DynamicEndpointing` 与 `StubEouModel` 路径一致、降级
- [x] 6.3 `pnpm -C packages/voice-detect typecheck && test` 绿;再跑全仓 typecheck+test 确认零改其它包
