## ADDED Requirements

### Requirement: 默认人格种子自带非空 self_notions

默认人格种子(小雪,`XIAOXUE_SEED`)SHALL 自带一组非空 `self_notions`(3 条或以上),每条含可匹配的话题线索关键词与一段第一人称立场文本,使确定性 stance 检测在相关话题上有可命中的真实观点——"会反对"落到具体话题,而非空转。用户配置 MUST 仍可整体替换或清空(用户自治,§6.2);本要求只约束**默认**种子非空。

#### Scenario: 默认种子的观点可被确定性检测命中

- **WHEN** 使用默认种子 `XIAOXUE_SEED`,且用户输入命中某条 self_notion 的话题关键词,assertiveness 不低于沉默门槛
- **THEN** `DefaultStanceDetector` 返回该条命中观点(非空 stance)

#### Scenario: 无关话题不命中

- **WHEN** 使用默认种子,用户输入与任何 self_notion 话题均无关
- **THEN** `DefaultStanceDetector` 返回空命中,回合照常进行
