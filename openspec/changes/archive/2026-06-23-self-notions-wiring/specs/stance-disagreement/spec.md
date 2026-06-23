## ADDED Requirements

### Requirement: 回合用持久化+可演化的立场来源

回合编排层 SHALL 经 `SelfNotionsManager`(首启用人格种子 self_notions、之后活在持久化 store)作为分歧检测的立场来源,而非直接读静态种子。每轮分歧检测 SHALL 读 `manager.current()`(反映已演化强度);回合收尾 SHALL 调 `manager.advance(userText, turn)` 推进强度演化。**默认(未注入演化器)行为 MUST 等价当前**:`current()` 等于种子立场、`advance` 为 no-op、stance 命中不变。演化器注入与否 MUST 由配置驱动(opt-in)。

#### Scenario: 默认未注入演化器时等价当前

- **WHEN** 未注入 selfNotionEvolver
- **THEN** 分歧检测用的立场等于人格种子的 self_notions,回合行为与接线前一致

#### Scenario: 立场跨重启持久

- **WHEN** 配置了持久化 store 且立场已演化
- **THEN** 进程重启后回合读到的是演化后的立场(从 store 恢复,而非回退种子)

### Requirement: LlmSelfNotionEvolver

系统 SHALL 提供 `LlmSelfNotionEvolver`(实现 `SelfNotionEvolver`):据本轮用户输入与当前立场,用 LLM 判定"用户确立/强化了哪几条立场",产出 `SelfNotionStrengthDelta[]`。任何失败(异常/乱码/无效/越界)SHALL 降级返回 null(本次不演化),绝不打断回合(§3.2)。强度增量的最终钳制由 `SelfNotionsManager` 接缝侧统一保证。

#### Scenario: LLM 判定确立立场产出增量

- **WHEN** 用户表达强化了某条已有立场且 LLM 正常返回
- **THEN** 演化器产出对应 topicKey 的正向强度增量

#### Scenario: LLM 失败降级不演化

- **WHEN** LLM 调用失败或返回无法解析
- **THEN** 演化器返回 null,立场不变,回合继续
