## ADDED Requirements

### Requirement: TtsOptions 支持按调用透传情绪/风格指令

`TtsOptions` SHALL 新增可选字段 `instruction`(通用"说话风格/情绪"自然语言 steer,按**每次合成调用**透传)。支持指令控制的 provider(如 CosyVoice)SHALL 以 `opts.instruction` 优先于构造期静态指令;未给 `opts.instruction` 时回落静态指令(逐字回归)。不支持指令的 provider SHALL 忽略该字段(纯加法,不报错)。

#### Scenario: 按调用 instruction 覆盖静态
- **WHEN** CosyVoiceTts 构造时配了静态指令,且某次 synthesize 传了 opts.instruction
- **THEN** 该次合成使用 opts.instruction(发 parameters.instruction)

#### Scenario: 未传则回落静态
- **WHEN** 某次 synthesize 未传 opts.instruction
- **THEN** 该次合成使用构造期静态指令(无则不发 instruction),与本能力引入前一致

#### Scenario: 不支持指令的 provider 忽略
- **WHEN** 对不消费 instruction 的 provider 传 opts.instruction
- **THEN** 正常合成、不报错(字段被忽略)

#### Scenario: qwen-tts 当前忽略 per-call instruction
- **WHEN** 对 QwenTtsRealtime 传 opts.instruction
- **THEN** 合成正常、不报错,但 opts.instruction 不生效(qwen-tts 仅用构造期静态 instructions;per-call 接入为后续扩展)
