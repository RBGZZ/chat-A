## ADDED Requirements

### Requirement: PersonaEngine 可从持久化 store 重载快照

`PersonaEngine` SHALL 提供从其持久化 store 重载当前快照(PAD/OCEAN/turn)的能力,使一个**只读**引擎能反映另一引擎(同一 store)已 advance 并保存的最新状态。重载 SHALL 安全:store 无快照时保持当前内存状态不变;不触发情绪推进、不写回。

#### Scenario: 重载反映另一引擎的最新 PAD
- **WHEN** 引擎 A(同一 store)advance 并保存了新 PAD,只读引擎 B 调用重载
- **THEN** 引擎 B 的 tone()/current() 反映新的 PAD

#### Scenario: store 空时安全
- **WHEN** store 尚无快照时调用重载
- **THEN** 保持当前内存快照不变,不抛错

#### Scenario: 重载不推进情绪
- **WHEN** 调用重载
- **THEN** 仅替换内存快照为 store 值,不调用 advance、不写回 store
