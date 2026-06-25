## ADDED Requirements

### Requirement: CosyVoiceTts 流式喂文本(单 task 增量合成)

`CosyVoiceTts` SHALL 提供流式喂文本的合成接口:在**一个** run-task(同 task_id、同 voice 上下文)内,允许**多次增量送入文本块**(经多次 `continue-task`),边送边产出 `PcmChunk` 流,最后收尾(`finish-task`)。该路径 SHALL 用于逐句流式合成,使首音不必等整段文本到齐;且因全程单 voice 上下文,**不引入逐句音色漂移**。既有一次性 `synthesize(text)` 路径 SHALL 保持不变(缺省/单语种逐字现状)。可注入 wsFactory/taskId 单测,不触网。

#### Scenario: 多次 pushText 进同一 task 流式产音
- **WHEN** 开流式合成 → 依次送入"句1""句2" → finish
- **THEN** 两句在同一 run-task 内合成,音频按到达顺序流式产出 PcmChunk(句1 先出声),全程同一 voice

#### Scenario: 单 voice 上下文不漂移
- **WHEN** 经多次 continue-task 增量送多句
- **THEN** 合成始终在同一 task/voice 上下文(非每句独立 task),音色一致

#### Scenario: 既有一次性合成不变
- **WHEN** 调用原 `synthesize(text)`
- **THEN** 行为与本能力引入前逐字一致(单 continue-task 送全文)

#### Scenario: 流式路径打断/降级
- **WHEN** 流式合成期间 AbortSignal 取消,或服务端 task-failed
- **THEN** 干净停止/关连接、透出错误,不崩
