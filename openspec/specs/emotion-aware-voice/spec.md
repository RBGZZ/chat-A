# emotion-aware-voice Specification

## Purpose
TBD - created by archiving change emotion-aware-voice. Update Purpose after archive.
## Requirements
### Requirement: 按当前心情实时驱动语音情绪

系统 SHALL 在开关启用时,据小雪当前 PAD 心情为每次语音合成计算一条情绪指令并注入 TTS,使复刻音色随情绪变化。该能力 SHALL 由配置开关(`CHAT_A_TTS_EMOTION_FROM_MOOD`)门控,**默认关闭**;关闭时合成回落到静态指令(`CHAT_A_TTS_INSTRUCTION`)或无指令,行为与启用前逐字一致。映射 SHALL 为确定性纯函数(可 golden 测),不调用 LLM。

#### Scenario: 启用时按心情注入情绪指令
- **WHEN** 开关启用且小雪当前 PAD 为某情绪态(如低落)
- **THEN** 该次合成携带由 PAD 推导的情绪指令(如"声音低沉,语气有些低落"),复刻音色据此表达

#### Scenario: 关闭时零回归
- **WHEN** 开关未启用
- **THEN** 合成不注入心情指令,沿用静态 `CHAT_A_TTS_INSTRUCTION`(或无),产出与本能力引入前一致

#### Scenario: 情绪随对话起伏逐回合变化
- **WHEN** 连续两回合小雪心情不同(如先开心后转低落)
- **THEN** 两回合各自合成所用情绪指令不同(每次合成是独立请求,指令逐回合重算)

#### Scenario: 映射不依赖外部、不阻塞
- **WHEN** 计算情绪指令
- **THEN** 由同步纯函数据 PAD 即时得出,不发起网络/LLM 调用、不进首字延迟热路径

