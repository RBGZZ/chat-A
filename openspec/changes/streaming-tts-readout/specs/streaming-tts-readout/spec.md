## ADDED Requirements

### Requirement: 朗读首句即合成、不等整段

启用流式朗读时,系统 SHALL 在回复生成过程中按句切分,**首句到齐即开始合成并出声**,不等整段回复完成、不等整段文本喂齐。逐句 SHALL 喂入**同一 TTS 合成会话**(单 voice 上下文),使音色与整段合成一致(不引入逐句漂移)。开关 SHALL 由 `CHAT_A_TTS_STREAM_READOUT` 门控,**默认关闭**;关闭时沿用整段一次合成,逐字回归。

#### Scenario: 首句先出声
- **WHEN** 流式朗读启用,回复第一句生成完成(整段尚未结束)
- **THEN** 该句即开始合成出声,后续句陆续接上

#### Scenario: 同会话喂不漂移
- **WHEN** 多句逐句喂入
- **THEN** 全程同一 TTS 会话/voice,音色与整段合成一致

#### Scenario: 默认关闭零回归
- **WHEN** `CHAT_A_TTS_STREAM_READOUT` 未启用
- **THEN** 朗读沿用整段一次合成,行为与本能力引入前一致

#### Scenario: 流式失败降级整段
- **WHEN** 流式合成出错(连接/协议)
- **THEN** 降级回整段一次合成(或跳过该次朗读),不崩、不中断主链路
