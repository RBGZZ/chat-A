## ADDED Requirements

### Requirement: 换段对话后刷新心情栏

reset(换段对话)后,desktop SHALL 刷新「心情」显示——先 reload 只读显示引擎到当前持久化 PAD,再 `emit(IPC.mood, ...)`,使心情栏立即反映当前心情,而非停在上一回合旧值直到下一回合。刷新失败 SHALL try/catch 兜底(不崩、不中断 reset,§3.2)。reset 的"换新 session、保留长期记忆与 PAD 续接"语义 SHALL 不变。

#### Scenario: reset 后心情栏即时刷新
- **WHEN** 用户点"换段对话"
- **THEN** 心情栏立即按当前 PAD 刷新(不等下一回合)

#### Scenario: 刷新失败不崩
- **WHEN** reset 后 reload/emit mood 出错
- **THEN** 吞错兜底,reset 正常完成,主链路不受影响

#### Scenario: 换段保留心情续接
- **WHEN** reset
- **THEN** 仍保留长期记忆与 PAD 心情(不重置情绪),只是 UI 被通知重读
