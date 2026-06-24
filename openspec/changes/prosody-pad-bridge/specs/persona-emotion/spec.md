## MODIFIED Requirements

### Requirement: PAD 情绪步进可并入语音 prosody 拉力

`PersonaEngine.advance` SHALL 在既有「文本 appraiser 拉力 → `stepPad` 步进」流程基础上,接受一个**可选**第二参数 `opts?: { prosodyEmotion?: SttEmotionLike }`,使 §7#5「从语音读情绪」可影响 PAD 情绪内核(§6.1)。当提供 `opts.prosodyEmotion` 时,`advance` MUST 经 `prosodyToPadPull(opts.prosodyEmotion)` 得语音侧拉力,与 appraiser 产出的文本拉力 `textPull` **按权重合并**为 `merged`:`merged_axis = clampUnit(textPull_axis + W · prosodyPull_axis)`(各维钳制 `[-1,1]`),其中 `W` MUST 为外置具名常量(`PROSODY_PULL_WEIGHT`,默认 `0.5`,行为即配置、无 magic number、语音为辅不盖文本),再以 `merged` 做**单次** `stepPad` 步进(与无语音时同一次步进,绝不二次步进/二次回归)。

当**未提供** `opts` 或 `opts.prosodyEmotion` 为 `undefined` 时,`advance` 的行为 MUST 与现状**逐字一致**:即所用拉力等于 `textPull`、经同一次 `stepPad` 步进,产出的 PAD / OCEAN 演化 / 持久化快照与本 change 前完全相同(纯加法、向后兼容、回归硬线)。入参 `prosodyEmotion` MUST 用结构类型 `SttEmotionLike`(`{ label: string; confidence?: number }`),使 persona **不依赖 providers 包**(接缝边界 §3.1)。`prosodyToPadPull` 对 `undefined`/未知/`neutral`/低 confidence 的优雅降级(零拉力/线性缩放)MUST 原样沿用——故提供一个 neutral/未知标签的 `prosodyEmotion` 时合并拉力等于 `textPull`,行为与不提供等价。

#### Scenario: 提供 prosody 情绪使 PAD 朝该情绪方向偏移

- **WHEN** 以注入了零文本拉力 appraiser 的 `PersonaEngine` 调 `advance('随便说点', { prosodyEmotion: { label: 'sad' } })`
- **THEN** 本轮 `stepPad` 的拉力为 `W · prosodyToPadPull({label:'sad'})`(负 pleasure/负 arousal/负 dominance),推进后 PAD 的 pleasure 较「不提供 prosody」时更低(语音情绪真实影响心情)

#### Scenario: 不提供 prosody 与现状逐字一致

- **WHEN** 以同一 seed/appraiser 分别跑 `advance(userText)` 与本 change 前的 `advance(userText)`
- **THEN** 两者产出的 PAD、turn、OCEAN、持久化快照逐字相等(golden:纯加法不改默认路径)

#### Scenario: neutral / 未知 prosody 标签等价于不提供

- **WHEN** 调 `advance(userText, { prosodyEmotion: { label: 'neutral' } })`
- **THEN** 因 `prosodyToPadPull` 对 neutral 返回零拉力,合并拉力等于 `textPull`,推进结果与 `advance(userText)` 全等(优雅降级)

#### Scenario: 语音拉力按外置权重 W 弱于文本(为辅不盖)

- **WHEN** 同一 prosody 情绪以权重 `W=PROSODY_PULL_WEIGHT`(默认 0.5)合并
- **THEN** 合并后语音侧对各维的贡献为 `W·prosodyPull`,严格弱于同量级文本拉力(语音为辅,§7#5 不喧宾夺主)
