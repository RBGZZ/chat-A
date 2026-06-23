# voice-mode-wiring Specification

## Purpose
TBD - created by archiving change voice-real-port-wiring. Update Purpose after archive.
## Requirements
### Requirement: 按 env 选择真/桩 VAD·EOU 实现

`cli --voice` 装配层 SHALL 按环境变量 `CHAT_A_VAD` 选择端点检测(VAD + EOU/TurnDetector)实现:值为 `silero`(或 `real` / `sherpa`)时走**真**路径(注入真 `SileroVadDetector` + `SmartTurnEouModel`);缺省、空、或其它值(含 `stub`)走**桩**路径(`StubVadDetector` + `TurnDetector(StubEouModel)`)。缺省(不设该 env)MUST 走桩,且语音装配与现有行为逐字不变(CI/冒烟默认)。VAD 与 EOU MUST 由同一开关一起切换(端点检测三层为一套)。

#### Scenario: 缺省走桩

- **WHEN** 未设置 `CHAT_A_VAD` 启动语音模式
- **THEN** 注入 `StubVadDetector` + `TurnDetector(StubEouModel)`,`info` 的 VAD/EOU 标识为桩,装配与现状一致

#### Scenario: 显式选真

- **WHEN** 设 `CHAT_A_VAD=silero` 且真 sherpa 模块可加载并满足端口形状
- **THEN** 注入真 `SileroVadDetector` + `SmartTurnEouModel`(由动态加载的 sherpa session 构造),`info` 的 VAD/EOU 标识为真

### Requirement: 动态加载真 sherpa 推理端口且不写入依赖

系统 SHALL 提供真推理 session 工厂(`createSherpaVadSession` / `createSherpaEouSession`),经**动态 import** 按模块名加载 sherpa-onnx(模块名经构造参数或 env `CHAT_A_SHERPA_MODULE` 可覆盖,缺省 `sherpa-onnx-node`),用**鸭子类型**把其同步推理面包成 `VadInferenceSession` / `EouInferenceSession`(`infer(samples: Float32Array): number` + `reset()`)。工厂返回类型 MUST NOT 暴露任何 sherpa-onnx / onnxruntime 原生类型(最小面)。sherpa-onnx MUST NOT 出现在任何 `package.json` 的 dependencies(沿用 `node-audio-device.ts` 隔离纪律,仅动态 import)。

#### Scenario: 动态加载并包成端口

- **WHEN** 工厂用一个导出了「吃 `Float32Array` 同步返回 `number`」推理面的模块构造
- **THEN** 返回实现 `VadInferenceSession` / `EouInferenceSession` 的对象,`infer` 转调底层得概率,`reset` 可安全调用

#### Scenario: 模块装不上抛明确中文错误

- **WHEN** 动态 import 指定模块失败(未安装)
- **THEN** 抛出明确中文错误,提示如何安装(`pnpm add`)及需本机 C++ 构建工具链

#### Scenario: 导出形状不符抛明确中文错误

- **WHEN** 模块已加载但鸭子类型挑不到可用的同步推理面
- **THEN** 抛出明确中文错误,指明需在该工厂模块处补薄适配桥接(而非静默错配)

### Requirement: 真路径加载/构造失败回落桩绝不崩

当真路径(`CHAT_A_VAD=silero`)的动态加载或适配器构造**任一步抛错**时,装配层 MUST 打印明确中文提示并**回落到桩**实现,绝不让语音模式崩溃(承 §3.2 优雅降级,沿用真音频设备装不上回落 Fake 的范式)。回落后 `info` 的 VAD/EOU 标识 MUST 反映实际生效的桩。

#### Scenario: 真模块缺失回落桩

- **WHEN** 设 `CHAT_A_VAD=silero` 但 sherpa 模块加载失败
- **THEN** 打印明确中文提示,回落注入桩,`startVoiceMode` 正常返回句柄不抛,`info` 标识为桩

#### Scenario: 适配器构造失败回落桩

- **WHEN** 真 session 已得但构造真适配器时抛错
- **THEN** 打印明确中文提示,回落注入桩,语音装配不崩

### Requirement: 状态行暴露实际 VAD·EOU 实现标识

`VoiceModeHandle.info` MUST 暴露当前实际生效的 VAD 与 EOU 实现标识(真/桩),`cli` 状态行 SHALL 一并打印,便于手测确认。标识 MUST 反映**回落后**的实际实现(真路径回落桩时显示桩)。

#### Scenario: info 含 VAD/EOU 标识

- **WHEN** 启动语音模式(任一路径)
- **THEN** `info` 含 `vad`、`eou` 字段,其值与实际注入的实现(经回落后)一致

