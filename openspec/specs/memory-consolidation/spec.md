# memory-consolidation Specification

## Purpose
TBD - created by archiving change nightly-consolidation. Update Purpose after archive.
## Requirements
### Requirement: 巩固触发编排(后台、幂等)

系统 SHALL 提供巩固编排,统一支持 会话结束 / 每日 / 每 N 轮 三类触发,执行全部后台异步且幂等(存在性检查防重复),不阻塞热路径与主对话。

#### Scenario: 三类触发判定
- **WHEN** 触发条件满足(会话结束 / 距上次巩固≥1 天 / 轮数≥N)
- **THEN** 编排器判定应巩固并后台执行(纯函数判定可注入时钟、可测)

#### Scenario: 幂等不重复
- **WHEN** 同一巩固单元(如某 session/某日)已巩固过
- **THEN** 再次触发被存在性检查跳过,不重复写

#### Scenario: 失败不影响主对话
- **WHEN** 巩固过程报错
- **THEN** 仅告警,主对话与同步 recall 不受影响(§3.2)

### Requirement: 离线双 Pass 调和(add/update/delete/discard)

系统 SHALL 在巩固中执行双 Pass 调和:提取候选 → 对标既有记忆 → 产 diff `{add/update/delete/discard}`;喂 LLM 对标时 SHALL 使用临时整数 ID(回映真 UUID 落库)抗幻觉;delete SHALL 保守(默认标记 discard/加速衰减,不物理删),核心/pinned 永不参与。

#### Scenario: 矛盾记忆被 update/discard
- **WHEN** 新候选与既有记忆冲突(如旧偏好被更新)
- **THEN** 调和产出 update 或 discard,而非新增矛盾条目

#### Scenario: LLM 只见临时整数 ID
- **WHEN** 把候选与既有记忆喂给 LLM 做对标
- **THEN** LLM 见到的是 `[1][2]…` 临时整数,返回的 diff 引用整数,代码回映真 UUID 落库

#### Scenario: delete 保守且核心豁免
- **WHEN** 调和判定某条应删除
- **THEN** 默认标记 discard/加速衰减(非物理删);若该条为 core/pinned 则永不删改

### Requirement: 惊奇门控编码(predict-calibrate)

系统 SHALL 在夜间巩固用 predict-calibrate 编码:由已有语义记忆预测本情景,与原文对比取 prediction gap,只把 gap 蒸馏入语义记忆。

#### Scenario: 只蒸馏预料之外
- **WHEN** 一段情景大部分可由已有语义记忆预测、仅小部分意外
- **THEN** 只把意外的 prediction gap 蒸馏入语义,不重复记录已知内容

#### Scenario: 门控失败优雅降级
- **WHEN** 惊奇评估 LLM 失败
- **THEN** 退回"不门控、照常蒸馏",不崩溃

### Requirement: 巩固可回放

系统 SHALL 把每次巩固的 diff、惊奇 gap、discard 理由落 SQLite 决策 trace,使巩固决策可重建。

#### Scenario: 重建为什么改/删
- **WHEN** 某条记忆被巩固改写或 discard
- **THEN** 可从决策 trace 重建该决策的输入与理由(§8.1)

