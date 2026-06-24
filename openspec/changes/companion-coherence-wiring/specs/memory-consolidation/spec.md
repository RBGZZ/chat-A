## ADDED Requirements

### Requirement: 巩固 daily / 每 N 轮触发驱动

系统 SHALL 在回合循环(cli)驱动巩固的 `daily` 与 `every-n-turns` 两类触发:cli SHALL 累计"距上次巩固以来的对话轮数"并记录"上次巩固时刻",在每个用户回合后(非首字热路径)以该状态调用既有触发判定 `shouldConsolidate('every-n-turns'/'daily', state, clock, params)`(经 `Consolidator.shouldRun`)。判定命中时 SHALL **后台 fire-and-forget** 触发一次巩固(复用既有 `consolidateSession` 句柄/路径),失败仅告警、绝不阻塞热路径或主对话(§3.2)。触发节奏阈值(`everyNTurns` / `dailyIntervalDays`)MUST 走 `ConsolidationConfig`(行为即配置,无 magic number)。触发后 SHALL 重置该窗口计数并更新上次巩固时刻;巩固单元(unit)幂等键 SHALL 保证同一窗口/同一天不重复巩固(配合 `Consolidator` 内部存在性检查)。既有 `session-end` 触发(退出收尾 / `/reset`)语义 MUST 保持不变。

#### Scenario: 轮数达阈值触发

- **WHEN** 距上次巩固累计轮数 `turnsSinceLast >= everyNTurns`
- **THEN** 编排器判定应巩固并后台 fire-and-forget 执行一次,随后重置该窗口计数

#### Scenario: 距上次巩固满间隔触发 daily

- **WHEN** 距上次巩固时刻 ≥ `dailyIntervalDays` 天(或从未巩固)
- **THEN** 编排器判定应巩固并后台执行(纯函数判定可注入时钟,确定性可测)

#### Scenario: 未达阈值不触发

- **WHEN** `turnsSinceLast < everyNTurns` 且距上次巩固 < `dailyIntervalDays` 天
- **THEN** 不触发巩固,回合正常继续

#### Scenario: 同窗口幂等不重复

- **WHEN** 同一巩固单元(同窗口轮次 / 同一天)已巩固过
- **THEN** 再次触发被存在性检查跳过,不重复写

### Requirement: 巩固节奏触发缺省关回归绿

巩固节奏触发 SHALL 沿用既有开关 `CHAT_A_CONSOLIDATION`(缺省 off):缺省 off 时 cli MUST NOT 构造 Consolidator、MUST NOT 累计轮数或记录巩固时刻、MUST NOT 调用任何节奏触发,**回合行为与未引入本接线时字面一致**(缺省安全)。仅 `CHAT_A_CONSOLIDATION=on` 时才装配巩固并启用 daily / 每 N 轮节奏触发。

#### Scenario: 缺省 off 时不计数不触发

- **WHEN** 未设置 `CHAT_A_CONSOLIDATION`(缺省 off)
- **THEN** cli 不构造 Consolidator、不计数、不触发任何巩固,行为与未引入本接线时逐字一致(既有测试全绿)

#### Scenario: on 时启用节奏触发

- **WHEN** `CHAT_A_CONSOLIDATION=on`
- **THEN** cli 装配 Consolidator 并在回合循环按轮数/日期驱动 daily 与每 N 轮触发,既有 session-end 触发不变
