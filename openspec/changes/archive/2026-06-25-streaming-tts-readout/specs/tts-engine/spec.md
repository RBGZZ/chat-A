## ADDED Requirements

### Requirement: CosyVoiceTts 同会话流式喂文本

`CosyVoiceTts` SHALL 提供同会话流式合成接口:在**一个** run-task(同 task_id、同 voice 上下文)内**多次增量送入文本块**(经多次 `continue-task`),边送边产出 `PcmChunk` 流,末尾 `finish-task` 收尾。该路径 SHALL 用于逐句流式,使首音不必等整段文本到齐;因全程单 voice 上下文,**不引入逐句音色漂移**(真机已验证:同 task 逐句喂 ≈ 整段一次喂,不漂)。既有一次性 `synthesize(text)` SHALL 保持不变。可注入 wsFactory/taskId 单测,不触网。

#### Scenario: 多次 pushText 进同一 task 流式产音
- **WHEN** 开流式合成 → 依次送入"句1""句2" → finish
- **THEN** 两句在同一 run-task 内合成,音频按到达顺序流式产出 PcmChunk(句1 先出声),全程同一 voice

#### Scenario: 既有一次性合成不变
- **WHEN** 调用原 `synthesize(text)`
- **THEN** 行为逐字不变(单 continue-task 送全文)

#### Scenario: 流式打断/服务端失败
- **WHEN** 流式期间 AbortSignal 取消,或服务端 task-failed
- **THEN** 干净停止/关连接、透出错误(含 error_code/message),不崩

#### Scenario: 注入 wsFactory 单测不触网
- **WHEN** 注入 mock WS + 固定 taskId
- **THEN** 流式喂/产音全程不触真网络,确定性可测
