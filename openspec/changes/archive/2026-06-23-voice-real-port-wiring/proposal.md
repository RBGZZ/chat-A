## Why

`@chat-a/voice-detect` 的真适配器(`SileroVadDetector` + `SmartTurnEouModel`,注入式同步推理端口 `VadInferenceSession` / `EouInferenceSession`)已落地,但 `cli --voice` 装配层(`packages/client/src/cli-voice.ts:89-92`)仍**硬编码用桩**(`new StubVadDetector([0.9])` / `new TurnDetector(new StubEouModel([0.9]))`)——「恒有声 + 高 EOU」占位序列。这意味着免提连续对话的端点检测**还不真**:小雪无法靠声学/韵律判断「用户有没有在说话」「这句说完没」。

缺口在装配层而非适配器:真 Silero / Smart-Turn v3 经 **sherpa-onnx 同步原生绑定**注入即可生效(适配器已就位、零改 VoiceLoop)。本切片补上**按 env 选真/桩 + 真路径加载失败回落桩**的装配,为 PC 手测「免提连续对话」铺路。沿用既有 `NodeAudioDevice`(动态 import + 鸭子类型 + 装不上明确报错)与 STT/TTS 工厂(按 env 选实现 + 缺配置降级)的范式。

## What Changes

- **新增真推理 session 工厂模块** `packages/client/src/audio/sherpa-vad-session.ts`:**动态 import** sherpa-onnx(模块名经构造参数/env `CHAT_A_SHERPA_MODULE` 可覆盖,默认 `sherpa-onnx-node`),用**鸭子类型**把其同步 VAD/EOU 推理包成 `VadInferenceSession` / `EouInferenceSession`。装不上 → 抛**明确中文错误**(提示 `pnpm add` + 需 C++ 工具链);形状不符 → 抛明确错误。**不把 sherpa-onnx 写进 package.json**(沿用 `node-audio-device.ts` 隔离纪律)。
- **改 `cli-voice.ts`**:按 env `CHAT_A_VAD`(`silero` → 真;缺省 `stub` → 桩)选择注入真 `SileroVadDetector` + `SmartTurnEouModel`(用上面工厂构造真 session)还是桩。真路径构造/加载失败 → **打印明确中文提示并回落桩**(沿用设备回落范式,绝不崩)。桩保持 CI/冒烟默认,文字模式与现有行为逐字不变。
- **状态行 `info` 增加 VAD/EOU 实现标识**(真/桩),便于手测时确认实际生效的实现。
- **测试**(用鸭子类型假 sherpa 模块):验证「`CHAT_A_VAD=silero` 选真适配器并正确包成端口 / 缺省选桩 / 真路径加载失败回落桩不崩 / info 标识正确」。真原生/真模型 headless 跑不了,不进 CI。

### Non-goals

- 不重写 `@chat-a/voice-detect` 的适配器(已实现,本切片只 import 使用)。
- 不把 sherpa-onnx-node 写进任何 package.json dependencies(只动态 import)。
- 不动 `packages/runtime` / `protocol` / `providers` / `voice-detect`(隔离纪律)。
- 不固定 sherpa-onnx-node 的真 VAD/EOU JS API 形状(见 design.md 假设);鸭子类型容错挑工厂,真形状以用户 PC 手测为准。

### 对延迟预算的影响(§3.2)

装配层零额外阻塞:真适配器推理仍同步内联在 `pushFrame`/`predict`(适配器既有行为);工厂只在启动时做一次动态 import + 鸭子挑选。缺省(不设 env)走桩,延迟特性与现状一致。

## Capabilities

### New Capabilities
- `voice-mode-wiring`: `cli --voice` 按 env 注入真/桩 VAD·EOU 端点检测实现的装配契约——动态加载真 sherpa-onnx 推理端口、加载/构造失败回落桩绝不崩、缺省走桩、状态行暴露实际实现标识。

## Impact

- **代码**:`packages/client/src/audio/sherpa-vad-session.ts`(新增工厂)+ `packages/client/src/cli-voice.ts`(按 env 选注入 + 回落 + info)+ `packages/client/test/`(假 sherpa 模块驱动的装配测试)。
- **依赖**:CI 依赖图**不变**(无原生包);真引擎经动态 import 注入。
- **接缝**:只 import `@chat-a/voice-detect` 既有 `SileroVadDetector` / `SmartTurnEouModel` / `VadInferenceSession` / `EouInferenceSession`(§3.1 接缝),不新增跨模块依赖。
- **canonical 章节**:§4(三层端点检测)、§5b(Silero / Smart-Turn v3)、§9(行 324 Sherpa-ONNX 方向);与权威设计一致,无冲突。
