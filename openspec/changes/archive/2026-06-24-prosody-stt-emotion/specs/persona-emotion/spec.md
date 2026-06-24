## ADDED Requirements

### Requirement: prosody 情绪映射 PAD 拉力(确定性内核)

系统 SHALL 提供确定性纯函数 `prosodyToPadPull(emotion?, map?)`,把 STT 读出的离散 prosody 情绪标签(§7#5「从语音读情绪」)映射成 PAD 拉力 `PadPull`,供 §6.1 `stepPad` 消费,使「怎么说的」与文本 appraiser 的「说了什么」并轨喂入 PAD 情绪内核。该函数 MUST 为纯函数(同入参输出全等,可 golden test),映射表 MUST 外置可配(`DEFAULT_PROSODY_PAD_MAP`,行为即配置、无 magic number、可注入覆盖)。

入参 MUST 用结构类型(`{ label: string; confidence?: number }`),使 persona **不依赖 providers 包**(接缝边界 §3.1)。映射 MUST 覆盖 qwen3-asr 的 7 类情绪(surprised/neutral/happy/sad/disgusted/angry/fearful);各维拉力结果 MUST 钳制到 `[-1,1]`。`emotion` 为 `undefined` / `label` 不在表内 / `label==='neutral'` 时 MUST 返回**零拉力** `{pleasure:0,arousal:0,dominance:0}`(安全降级:`stepPad` 仅按基线回归、不施加语音拉力)。若 `confidence∈(0,1]` 则拉力 MUST 按 confidence 线性缩放,缺省视作 1(不缩放)。

#### Scenario: 7 类情绪映射为确定性 PAD 拉力

- **WHEN** 以 `{label:'sad'}`、`{label:'happy'}`、`{label:'angry'}` 等分别调用 `prosodyToPadPull`
- **THEN** 各返回 `DEFAULT_PROSODY_PAD_MAP` 中对应的 `PadPull`(如 sad 为负 pleasure/负 arousal/负 dominance、happy 为正 pleasure 等),且两次同入参调用结果全等

#### Scenario: 缺省/未知/中性情绪返回零拉力

- **WHEN** 以 `undefined`、`{label:'neutral'}`、或 `{label:'__unknown__'}` 调用 `prosodyToPadPull`
- **THEN** 返回零拉力 `{pleasure:0,arousal:0,dominance:0}`(喂 `stepPad` 不改变语音侧贡献,链路对无情绪信号优雅降级)

#### Scenario: 置信度线性缩放拉力

- **WHEN** 以 `{label:'sad', confidence:0.5}` 调用 `prosodyToPadPull`
- **THEN** 返回的拉力各维为 `sad` 基准拉力 × 0.5(确定性可断言);`confidence` 缺省或非 `(0,1]` 时不缩放
