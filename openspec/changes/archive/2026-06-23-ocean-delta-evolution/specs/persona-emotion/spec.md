## ADDED Requirements

### Requirement: 二级 OCEAN delta 演化(慢变量)

系统 SHALL 每隔可配置的 N 轮(默认 20)触发一次二级 OCEAN 信号分析,据近段对话给 OCEAN 五维产出一个微调 delta 并写回 OCEAN(§6.1 delta 演化)。触发节拍判定与 delta 应用 MUST 为确定性、可写 golden test;演化能力默认关闭(未注入 `OceanEvolver` 时 OCEAN 恒定)。

#### Scenario: 满 N 轮触发演化

- **WHEN** 已注入 `OceanEvolver` 且回合推进到第 N 的整数倍轮
- **THEN** 该轮触发一次 OCEAN 二级演化,OCEAN 被(钳制后的)delta 微调

#### Scenario: 未满 N 轮不演化

- **WHEN** 已注入 `OceanEvolver` 但当前轮次不是 N 的整数倍
- **THEN** 本轮不触发 OCEAN 演化,OCEAN 维持不变

#### Scenario: 默认关闭

- **WHEN** 未注入任何 `OceanEvolver`,正常推进任意轮数
- **THEN** OCEAN 始终等于种子/上次值,不发起任何演化相关调用

### Requirement: 单次 OCEAN delta 钳制上限

系统 SHALL 把单次演化的每维 OCEAN delta 钳制在可配置上限内(默认 ±0.01),且应用后的 OCEAN 维度钳回合法区间 [0,1](§6.1)。钳制 MUST 为纯函数,即使信号源返回越界值也不得突破上限。

#### Scenario: 越界 delta 被钳到上限

- **WHEN** 信号分析返回某维 delta 远超上限(如 +1)
- **THEN** 实际应用的该维 delta 不超过 +0.01(上限),OCEAN 仍落在 [0,1]

#### Scenario: 非有限 delta 视作零

- **WHEN** 信号分析某维返回 NaN/Infinity 等非有限值
- **THEN** 该维 delta 视作 0,OCEAN 该维不变

### Requirement: OCEAN 演化版本快照 history

每次实际发生的 OCEAN 演化 SHALL 追加一条版本快照(含旧 OCEAN、新 OCEAN、实际 delta、触发轮次、时间戳)到持久化 history,以支持回溯/回滚(§6.1 版本快照 history,数据迁移纪律)。快照构造 MUST 为确定性、可写 golden test。

#### Scenario: 演化写入一条快照

- **WHEN** 一次演化实际改变了 OCEAN
- **THEN** history 追加恰好一条快照,其 before=旧 OCEAN、after=新 OCEAN、delta=已钳制的实际 delta、turn=触发轮次

#### Scenario: 跳过的演化不写快照

- **WHEN** 信号分析返回空(不演化)或全零 delta
- **THEN** history 不新增条目,OCEAN 不变

### Requirement: OCEAN 演化失败优雅降级

OCEAN 二级演化基于可注入的 `OceanEvolver` 接缝(§3.1),且 MUST 全程优雅降级:无 LLM、调用异常、返回乱码或无有效维度时,本次演化被跳过,OCEAN 与回合均不受影响(§3.2 优雅降级)。LLM 版实现照 `complete + tolerantJsonParse + 失败降级` 范式,默认关闭、opt-in。

#### Scenario: 解析失败跳过演化

- **WHEN** 注入的 LLM `OceanEvolver` 在触发轮返回无法解析为有效 delta 的内容
- **THEN** 本次演化被跳过,OCEAN 不变,回合正常完成,不抛出异常

#### Scenario: 合规 JSON 经钳制后应用

- **WHEN** 注入的 LLM `OceanEvolver` 在触发轮返回合规的五维 delta JSON(含越界值)
- **THEN** 各维 delta 被钳到 ±上限后应用到 OCEAN,并写入一条版本快照

### Requirement: 持久化快照向后兼容 history 字段

持久化的 `PersonaSnapshot` SHALL 以向后兼容的加法扩展出可选的 OCEAN 演化 history 字段;读取旧快照(无 history)MUST 正常恢复人格状态(视作空 history),且 history 字段损坏绝不导致人格状态(OCEAN/PAD/turn)丢失(§3.2 数据迁移纪律,人格状态绝不丢)。

#### Scenario: 旧快照无 history 正常读回

- **WHEN** 加载一个不含 history 字段的旧持久化快照
- **THEN** OCEAN/PAD/turn 正常恢复,history 视作空,不报错

#### Scenario: history 损坏不丢人格状态

- **WHEN** 持久化快照的 history 字段形状非法,但 OCEAN/PAD/turn 合法
- **THEN** 人格状态(OCEAN/PAD/turn)仍被正常恢复,不因 history 损坏而整体回退种子
