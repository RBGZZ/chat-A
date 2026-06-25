## ADDED Requirements

### Requirement: desktop mood 显示与朗读读取活 PAD

desktop SHALL 在回合结束后,使 mood 显示(`IPC.mood`)与 emotion-aware-voice 朗读读取**当前活 PAD**——即先把只读 mood 引擎与会话已持久化的 PAD 同步(重载),再取数。不得再读开机时的 stale 快照。同步 SHALL 廉价(一次 store 读)、失败不崩(降级用旧值,§3.2)。

#### Scenario: 回合后 mood 栏反映新心情
- **WHEN** 一个文字回合结束、PAD 已推进保存
- **THEN** `IPC.mood` 推送的是该回合后的心情(非开机值)

#### Scenario: 朗读读到活 PAD
- **WHEN** emotion-aware-voice 开启,回合结束触发朗读
- **THEN** 朗读所用情绪指令来自该回合后的活 PAD(随对话起伏)

#### Scenario: 同步失败优雅降级
- **WHEN** 活 PAD 同步(重载)出错
- **THEN** 回落用现有快照,mood/朗读不崩、不中断
