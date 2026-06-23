## ADDED Requirements

### Requirement: self_notions 作为反对依据

PersonaCard SHALL 支持 `self_notions`——Agent 自己的观点/信念/好恶(她相信什么、讨厌什么、对什么有看法),每条至少含可匹配的话题线索与一段立场文本。`self_notions` MUST 全部由配置驱动(用户自治,§6.2),缺省为空且不影响其余功能。每条 `self_notion` SHALL 在启动时作为 `subject=agent` 记忆(kind=`self_notion`)写入 `MemoryStore`(ADD+去重,§5.8),使其可被召回并参与上下文;重复启动 MUST 幂等。

#### Scenario: 卡中 self_notions 装配并种子化

- **WHEN** PersonaCard 提供了一条或多条 self_notions
- **THEN** 每条以 `subject=agent`、kind=`self_notion` 写入存储,且可在装配出的人格数据中被分歧检测访问

#### Scenario: 无 self_notions 不影响功能

- **WHEN** PersonaCard 未提供 self_notions
- **THEN** 装配与回合照常进行,仅不产出针对具体观点的异议

### Requirement: StanceDetector 分歧检测接缝

系统 SHALL 提供 `StanceDetector` 接缝:据本轮用户输入与 `self_notions` 产出本轮 stance 结果(异步签名以容纳 LLM 实现,确定性实现返回已决议 Promise)。系统 SHALL 提供**确定性默认实现**,据用户输入对 self_notions 做话题相关性命中(归一化关键词匹配),只判定"该话题 Agent 有立场",MUST NOT 臆测语义层面的同异(语义冲突交由生成 LLM 判断)。系统 SHALL 允许注入 **LLM 实现**(默认关),其失败时 MUST 降级到确定性实现或空结果,绝不中断回合(§3.2)。检测 MUST 由回合编排层调用,assembler 不自取(§3.1)。

#### Scenario: 话题命中产出 stance

- **WHEN** 用户输入命中某条 self_notion 的话题线索
- **THEN** 检测器返回包含该 self_notion 立场的 stance 结果

#### Scenario: 无命中返回空

- **WHEN** 用户输入与任何 self_notion 话题均不相关
- **THEN** 检测器返回空 stance(不含具体观点)

#### Scenario: LLM 检测器失败降级

- **WHEN** 注入了 LLM StanceDetector 且其调用失败
- **THEN** 回合继续,退回确定性结果或空 stance,不抛出中断回合

### Requirement: DissentContributor 注入异议与反谄媚基线

系统 SHALL 提供 `DissentContributor`,注册到 §5.4 PromptAssembler 的预留"异议"优先级槽(靠近末尾的高 priority),据本轮 `ctx.stance` 与 `assertiveness` 注入:① 一条**反谄媚基线指令**(允许并鼓励她在不认同时坦诚表达、不为迎合而附和);② 当 stance 含具体 self_notion 时,附上该观点供她据以表态。contributor MUST 同步、无 I/O(承接缝契约);无任何可注入内容时 MUST 返回 `null`。

#### Scenario: 命中观点时注入异议段

- **WHEN** 本轮 `ctx.stance` 含一条 self_notion 且 assertiveness 高于触发阈值
- **THEN** 组装出的 system 含反谄媚基线 + 该观点的表态指令,位于靠近末尾的优先级

#### Scenario: 无观点但仍可注入基线

- **WHEN** 本轮无具体 stance 但 assertiveness 高于阈值
- **THEN** 注入反谄媚基线指令(不含具体观点段)

#### Scenario: 温和顺从时不注入

- **WHEN** assertiveness 处于最低档(温和顺从)且无具体 stance
- **THEN** DissentContributor 返回 `null`,不拼入任何异议/基线段

### Requirement: assertiveness 旋钮端到端调制异议

`assertiveness` 旋钮 SHALL 端到端可观测地调制反谄媚行为:低值(温和顺从)抬高话题命中的触发门槛、并弱化/不注入基线指令;高值(敢顶嘴有主见)降低触发门槛、强化基线措辞与异议表达强度。映射阈值与措辞档位 MUST 外置为配置(行为即配置,§3.2),无 magic number。

#### Scenario: 提高 assertiveness 增强异议

- **WHEN** 在同一输入与 self_notions 下提高 `assertiveness`
- **THEN** 注入的异议/基线更易触发且措辞更强,可在组装出的 system 文本上观测到差异

#### Scenario: 最低 assertiveness 趋于顺从

- **WHEN** 将 `assertiveness` 置于最低档
- **THEN** 不注入反谄媚基线,且话题命中需更强相关才产出观点(趋于温和顺从)
