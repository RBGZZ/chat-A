## Context

`@chat-a/voice-detect` 已提供:
- `SileroVadDetector`(注入 `VadInferenceSession`,实现 `VadDetector`)
- `SmartTurnEouModel`(注入 `EouInferenceSession`,实现 `EouModel`)
- 同步端口接口 `VadInferenceSession` / `EouInferenceSession`(`infer(samples: Float32Array): number` + `reset()`,不暴露原生类型)
- `DEFAULT_VAD_INFERENCE`(512 样本窗 / 16k)、`DEFAULT_EOU_INFERENCE`(maxWindowMs 等)

`cli-voice.ts` 当前硬编码桩。本切片在 client 装配层补「按 env 选真/桩 + 真路径失败回落桩」,沿用两条既有范式:
1. `node-audio-device.ts`:动态 `import(/* @vite-ignore */ moduleName)` + 鸭子类型挑工厂 + 装不上抛明确中文错误,**不写原生包进 package.json**。
2. `createStt/createTts`:按 env 选实现,缺配置降级。

## Goals / Non-Goals

- Goal:`CHAT_A_VAD=silero` 注入真适配器(用动态加载的 sherpa session);缺省走桩;真路径加载/构造失败回落桩并打印明确中文提示,绝不崩。
- Goal:状态行 `info` 暴露 VAD/EOU 实际实现标识(真/桩)。
- Goal:无原生库环境下用鸭子类型假 sherpa 模块完整测「选真/选桩/加载失败回落」。
- Non-Goal:不重写 voice-detect 适配器;不写 sherpa-onnx 进 package.json;不固定 sherpa-onnx-node 真 API 形状。

## Decisions

### 决策 1:env 开关与默认值

- `CHAT_A_VAD`:`silero`(或 `real` / `sherpa`)→ 真路径;缺省 / 其它 / `stub` → 桩。**缺省走桩**(CI/冒烟默认,文字模式与现状逐字不变)。
- `CHAT_A_SHERPA_MODULE`:覆盖要动态 import 的模块名;缺省 `sherpa-onnx-node`(沿用 `CHAT_A_AUDIO_MODULE` 范式)。
- VAD 与 EOU 由同一开关 `CHAT_A_VAD` 一起切(端点检测三层是一套,免提连续对话需两者同真才有意义);若将来要分别切再拆。

### 决策 2:工厂模块形状(`sherpa-vad-session.ts`)

导出两个工厂:
- `createSherpaVadSession(opts?): Promise<VadInferenceSession>`
- `createSherpaEouSession(opts?): Promise<EouInferenceSession>`

各自:动态 import 模块名(`opts.nativeModule` ?? env ?? 默认)→ 鸭子类型从导出里挑出「能同步推理一窗得概率」的可调用面 → 包成 `infer(samples: Float32Array): number` + `reset()`。装不上 / 形状不符 → 抛明确中文错误(提示 `pnpm add` + 需 C++ 工具链)。

**不暴露原生类型**:工厂返回值类型即 voice-detect 的端口接口,sherpa 句柄仅闭包内持有。

### 决策 3:sherpa-onnx-node 真 API 形状不确定 → 鸭子类型容错 + 适配 seam(关键假设)

**已知事实有限**:findings 文档确认 sherpa-onnx 端侧首选、自带 Silero VAD、纯 CPU,但**未固定 `sherpa-onnx-node` 的 JS VAD/EOU 推理 API 形状**(其真实 API 更像 `Vad`/`CircularBuffer` + `acceptWaveform`/`isSpeechDetected`,而非一发一窗得概率的纯函数)。任务也明示「sherpa-onnx Node API 同步推理形状不确定别硬猜,停下并说明假设」。

**做法**(不硬猜真形状,把不确定性收敛到一处可手测的鸭子挑选 + 适配函数):
- 工厂用 `pickProbInferer(mod)` 鸭子挑出一个「吃 `Float32Array` 同步返回 `number`」的可调用面,容错覆盖几种常见导出布局(顶层函数 / `default` / 具名 `infer`/`compute`/`run` 方法 / 工厂返回带该方法的对象)。
- 真 sherpa 的 VAD/EOU 若**不是**这种「一窗一概率」纯函数形状(很可能如此),则**这层鸭子挑选会挑不到 → 抛明确中文错误**,提示用户:需在本模块写一个把 sherpa `Vad`/会话桥接成 `infer(window)->prob` 的薄适配(指明改这一处),而非静默错配。
- 这样:CI 用假模块(直接导出 `infer`)走通真路径装配;真 PC 手测时,用户按错误提示补薄桥接即生效——**接缝形状(端口 + 工厂 + 鸭子挑选 + 失败回落)本切片定死,真 sherpa 调用细节留手测**。

**假设记录**:假定 sherpa session 一旦包成「同步 `infer(Float32Array)->number`」即满足 voice-detect 端口(适配器只要求这点)。若 sherpa 真 API 需异步或流式 buffer 语义,则需在本工厂内做同步缓冲适配(留 TODO 注释,不在本切片实现,因 headless 无法验证)。

### 决策 4:cli-voice 回落范式

`createDetectors(env)`(新内部函数):
- 桩路径:返回 `{ vad: StubVadDetector, turnDetector: TurnDetector(StubEouModel), vadKind: 'stub', eouKind: 'stub' }`(与现状逐字一致的占位序列 `[0.9]`)。
- 真路径(`CHAT_A_VAD=silero`):`await createSherpaVadSession` / `createSherpaEouSession` → `new SileroVadDetector({ session })` / `new TurnDetector(new SmartTurnEouModel({ session }))`;**任一步抛错** → `stdout.write` 明确中文提示 → 回落桩(沿用设备 try/catch 回落)。
- `startVoiceMode` 调它拿 detectors,把 `vadKind`/`eouKind` 并进 `info`。

### 决策 5:info 标识

`VoiceModeHandle.info` 增加 `vad: string`、`eou: string`(`'silero'`/`'stub'` 等)。`cli.ts` 状态行 already 拼 `voice.info.*`,顺带补打 VAD/EOU(在 client 内,允许改 cli.ts)。

## Risks / Trade-offs

- **真 sherpa API 形状未定**(决策 3):缓解=鸭子挑不到即明确报错指明改哪;真形状以手测为准,本切片不冒险硬编码错误的调用。
- **同步假设**:voice-detect 端口要求同步 `infer`;若 sherpa 真 API 异步,需工厂内缓冲适配(留 TODO,headless 不验)。
- 缺省走桩 → 零回归:不设 env 时行为与现状逐字一致。

## Migration Plan

无数据迁移。纯装配层 + 新增可选 env;缺省行为不变。

## Open Questions

- sherpa-onnx-node 的确切 VAD/EOU JS 推理 API(同步?一窗一概率?还是 `Vad`+buffer 流式?)——留真 PC 手测确认,届时在 `sherpa-vad-session.ts` 的鸭子挑选 / 薄适配处收敛。
