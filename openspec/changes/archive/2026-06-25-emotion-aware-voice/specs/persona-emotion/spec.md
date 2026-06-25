## ADDED Requirements

### Requirement: PAD 心情映射为语音情绪指令

persona SHALL 提供确定性纯函数,把 PAD(pleasure/arousal/dominance)映射为一句自然语言**语音情绪指令**字符串(供 TTS instruction 用)。映射 SHALL:仅表达情绪/语气维度(**不含语速**,语速由 TTS rate 独立控制);产出长度 SHALL 不超过 100 字符(超出截断保护);中性/接近基线的 PAD SHALL 产出温和或空指令;**不依赖 providers**(用结构类型,镜像 prosodyToPadPull 的解耦)。相同 PAD 输入 SHALL 得到相同输出(golden 可测)。

#### Scenario: 低落心情
- **WHEN** PAD 为低 pleasure + 低 arousal
- **THEN** 返回表达低落/低沉语气的指令(如"声音低沉,语气有些低落")

#### Scenario: 愉悦心情
- **WHEN** PAD 为高 pleasure + 较高 arousal
- **THEN** 返回表达轻快上扬的指令(如"语气轻快上扬,带点雀跃")

#### Scenario: 中性回落
- **WHEN** PAD 接近基线/中性
- **THEN** 返回温和或空的指令(不强加情绪)

#### Scenario: 长度截断
- **WHEN** 映射结果超过 100 字符
- **THEN** 截断到 ≤100 字符(满足 CosyVoice instruction 上限)

#### Scenario: 确定性
- **WHEN** 同一 PAD 多次调用
- **THEN** 每次返回完全相同的指令字符串

### Requirement: ToneView 暴露语音情绪指令

persona 的 `ToneView` SHALL 新增 `voiceInstruction` 字段(与 emotion/toneFragment 同源、纯加法),供编排层无需自行调用映射即可取用当前心情对应的语音指令。新增字段 SHALL 不改变既有 emotion/toneFragment/pad/posture 的值与行为。

#### Scenario: tone() 返回含 voiceInstruction
- **WHEN** 调用 `engine.tone()`
- **THEN** 返回的 ToneView 含 `voiceInstruction`(由当前 PAD 经映射得出),且 emotion/toneFragment/pad 字段逐字不变
