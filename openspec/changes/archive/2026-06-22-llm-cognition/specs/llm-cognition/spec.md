## ADDED Requirements

### Requirement: Provider 非流式补全

`LlmProvider` SHALL 提供非流式补全 `complete(req): Promise<string>`,返回完整文本。所有实现(anthropic / deepseek / fake)MUST 提供该方法。`complete` MUST 保持厂商无感:调用方不得依据 provider id/model 分支业务逻辑(仅 trace)。

#### Scenario: complete 返回完整文本

- **WHEN** 对任一已注册 Provider 调用 `complete`
- **THEN** 返回该次请求的完整文本(非增量),可直接解析

#### Scenario: fake provider 可注入罐装补全(record-replay)

- **WHEN** 测试用 fake provider 配置一个罐装返回串
- **THEN** `complete` 返回该串,使 appraiser/extractor 的解析与降级可确定性测试

### Requirement: LLM 情绪评估实现

系统 SHALL 提供一个基于 `complete` 的 `Appraiser` 实现,将用户消息评估为 PAD pull(承 §6.1 OCC→PAD)。它 MUST 与确定性默认实现并存、经配置切换、**默认不启用**(默认仍走确定性 appraiser,保证既有行为/测试不变)。LLM 返回 MUST 经容错解析映射到合法 PAD pull。

#### Scenario: 正常返回映射为 PAD pull

- **WHEN** LLM 对一条明显负面的用户消息返回合规 JSON 评估
- **THEN** 产出的 PAD pull 为负向(降低愉悦),并落在合法区间

#### Scenario: 默认不启用

- **WHEN** 未在配置中开启 LLM appraiser
- **THEN** 回合使用确定性默认 appraiser,不发起评估用的 LLM 调用

### Requirement: LLM 记忆抽取

系统 SHALL 提供 `MemoryExtractor` 接缝及一个基于 `complete` 的实现,在回合结束后从(用户输入 + 回复)抽取 0..N 条要点/偏好并经 `addMemory` 写入(复用已有 ADD + 去重)。它 MUST 经配置切换、**默认不启用**(默认保持既有写入来源行为)。抽取 MUST NOT 阻塞流式回复(回合后进行)。

#### Scenario: 抽取要点并去重写入

- **WHEN** 开启抽取,且 LLM 从一轮对话返回两条要点(其一与既有记忆等价)
- **THEN** 新要点被写入、等价要点被去重(不新增重复行)

#### Scenario: 默认走原行为

- **WHEN** 未开启 LLM 抽取
- **THEN** 记忆写入沿用既有来源,不发起抽取用的 LLM 调用

### Requirement: 容错解析

appraiser 与 extractor 解析 LLM 文本 MUST 容错:能从可能含多余文字/代码围栏的返回中提取目标 JSON;字段缺失或类型不符时按缺省/丢弃处理,不抛错给回合。

#### Scenario: 从带围栏的返回提取 JSON

- **WHEN** LLM 返回的文本把 JSON 包在 ```json ... ``` 围栏或前后夹带说明文字
- **THEN** 解析器仍能取出有效 JSON 并产出结果

#### Scenario: 非法返回不致命

- **WHEN** LLM 返回完全无法解析为目标结构的文本
- **THEN** 解析返回空/缺省结果,回合继续而不抛错

### Requirement: LLM 故障优雅降级

当评估/抽取的 LLM 调用失败(异常/超时/乱码)时,系统 MUST 优雅降级:appraiser 回退到确定性实现产出 pull,extractor 跳过本轮抽取;两者 MUST NOT 打断或拖垮主对话回合(§3.2),并记录错误(§8.1)。

#### Scenario: appraisal 调用失败回退确定性

- **WHEN** 启用 LLM appraiser,但其 `complete` 调用抛错
- **THEN** 该轮改用确定性 appraiser 的 pull,回合正常完成,错误被记录

#### Scenario: extraction 调用失败跳过

- **WHEN** 启用 LLM 抽取,但其 `complete` 调用抛错
- **THEN** 本轮不写入抽取记忆,回合正常完成,错误被记录

### Requirement: 延迟预算保护

默认配置 MUST 不增加回合首字延迟:记忆抽取在回合后进行;LLM 情绪评估默认在回合后评估、影响**下一轮**心情。若配置为回合前评估(影响当轮),系统 MAY 引入一次额外调用延迟,该模式 MUST 非默认且文档标注(§3.2)。

#### Scenario: 默认零首字延迟

- **WHEN** 用默认配置开启 LLM appraiser 与抽取
- **THEN** 首字流式输出前不发起评估/抽取调用(评估影响下一轮、抽取在回合后)
