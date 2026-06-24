# frame-processing Specification

## Purpose
TBD - created by archiving change autonomy-runtime-wiring. Update Purpose after archive.
## Requirements
### Requirement: SentenceAggregator 句级聚合

系统 SHALL 提供 `SentenceAggregator` 处理器,把 LLM token 流聚合为句级单元供下游 TTS 消费,接入 VoiceLoop 的"说"路径(替换或等价于现有 SentenceSplitter 并保持既有测试通过)。

#### Scenario: token 流聚成句
- **WHEN** LLM 以 token 流输出一段含多句的回复
- **THEN** SentenceAggregator 按句边界输出句级单元,首句尽快下发以降 TTFA

### Requirement: ClassifierProcessor 三层过滤分流

系统 SHALL 提供 `ClassifierProcessor`(纯函数),从 LLM delta 中剥离工具调用 / 表情标签 / 舞台指示,并分流为 `{displayText, spokenText, emotionTags}`——口语文本→TTS、情绪标签→人格、显示文本→记录。

#### Scenario: 剥离标签并分流
- **WHEN** LLM 输出含表情标签/舞台指示/工具调用片段的文本
- **THEN** spokenText 仅含可朗读口语(不含标签),emotionTags 提取情绪,displayText 供显示;三者分流到各自下游

#### Scenario: 纯函数可 golden test
- **WHEN** 以固定输入调用 ClassifierProcessor
- **THEN** 输出确定(同输入同输出),可写 golden test

