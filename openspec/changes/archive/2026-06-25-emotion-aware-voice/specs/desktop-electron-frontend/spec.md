## ADDED Requirements

### Requirement: desktop 朗读按当前心情注入情绪指令

当 `CHAT_A_TTS_EMOTION_FROM_MOOD` 启用时,desktop 朗读路径 SHALL 在合成每条回复前读取小雪当前心情(`persona.tone()` 的 PAD / voiceInstruction),计算情绪指令并作 `TtsOptions.instruction` 逐句注入,使复刻音色随心情说话。开关 SHALL **默认关闭**;关闭时朗读沿用静态 `CHAT_A_TTS_INSTRUCTION`(或无),逐字回归。

#### Scenario: 启用时朗读带当前心情
- **WHEN** 开关启用,某条回复合成时小雪处于某情绪态
- **THEN** 该回复以对应情绪指令朗读(复刻音色随情绪变化)

#### Scenario: 关闭时不变
- **WHEN** 开关未启用
- **THEN** 朗读不注入心情指令,行为与本能力引入前一致

#### Scenario: 心情读取失败优雅降级
- **WHEN** 启用但读取心情/计算指令出错
- **THEN** 朗读回落到无心情指令(静态或无),不崩、不中断朗读
