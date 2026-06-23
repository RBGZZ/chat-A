# memory-reflection Specification

## Purpose
TBD - created by archiving change reflection-consolidation. Update Purpose after archive.
## Requirements
### Requirement: Reflector 接缝

系统 SHALL 定义一个类型化的 `Reflector` 接缝，方法 `reflect(sessionId): Promise<void>`，用于会话结束后把该会话对话蒸馏成高层记忆并写回 `MemoryStore`。系统 MUST 提供一个默认的 `NoopReflector`（什么都不做）与一个 `LlmReflector`（用 LLM 蒸馏）实现，二者满足同一接缝；调用方 MUST 只依赖该接缝，不引用具体实现内部（承 §3.1）。`Reflector` 的写回 MUST 经由注入的 `MemoryStore.addMemory`，复用既有 ADD+去重，不绕过去重直接写库。

#### Scenario: Noop 默认不沉淀

- **WHEN** 对 `NoopReflector` 调用 `reflect(sessionId)`
- **THEN** 它正常 resolve，不向 `MemoryStore` 写入任何记忆，也不抛错

#### Scenario: 上层只依赖接缝

- **WHEN** 客户端在会话结束触发沉淀
- **THEN** 它通过注入的 `Reflector` 接缝调用 `reflect`，不引用任何具体实现类型

### Requirement: 会话蒸馏写回两类高层记忆

`LlmReflector` SHALL 读取本会话消息，用 LLM 一次蒸馏出两类记忆并经 `addMemory` 写回：少数"最显著的高层 Q&A"以 `subject='shared'` 写回（主用户与 Agent 的共同经历，承 §5.3），Agent 第一人称自传/日记以 `subject='agent'` 且 `kind` 为可配置的沉淀种类（默认 `'reflection'`）写回（agent 主语不关联人物）。高层 Q&A 的条数 MUST 受可配置上限约束（防失控）。蒸馏结果中非法/空的条目 MUST 被丢弃，不写入。

#### Scenario: 蒸馏出高层 Q&A 与第一人称自传

- **WHEN** 一段非空会话被 `LlmReflector.reflect`，LLM 返回若干高层 Q&A 与一段第一人称自传
- **THEN** 高层 Q&A 以 `subject='shared'` 写回、第一人称自传以 `subject='agent'` 且沉淀 `kind` 写回，均可被召回

#### Scenario: 高层 Q&A 受上限约束

- **WHEN** LLM 返回的高层 Q&A 数量超过可配置上限
- **THEN** 写回的高层 Q&A 条数不超过该上限

#### Scenario: 写回复用 ADD 去重

- **WHEN** 蒸馏出的某条记忆与既有记忆规范化后等价
- **THEN** 它不产生重复行（累加命中），与既有写路径去重语义一致

### Requirement: 会话级幂等

`LlmReflector` SHALL 对同一会话幂等：用 `MemoryStore` 的状态 KV 以可配置前缀的键（默认 `diary_{sessionId}`）标记某会话是否已沉淀。进入 `reflect` 时若该会话已有标记，MUST 安静跳过（不再调用 LLM、不再写回）。仅在确实成功写回至少一条沉淀后，MUST 写入该会话的标记。

#### Scenario: 已沉淀的会话再次触发被跳过

- **WHEN** 同一 `sessionId` 第二次调用 `reflect`
- **THEN** 不再调用 LLM、不新增任何记忆行

#### Scenario: 成功沉淀后留下标记

- **WHEN** 一次 `reflect` 成功写回至少一条沉淀
- **THEN** 该会话的状态 KV 标记被写入，使后续重复触发被幂等跳过

### Requirement: 沉淀全程优雅降级

会话沉淀 MUST 全程优雅降级，绝不把异常抛给调用方（承 §3.2）：本会话无消息、LLM 调用失败、蒸馏结果无法解析或字段全部非法等情况下，`reflect` MUST 安静跳过（resolve）且不写回。沉淀 MUST 不进入任何回合 / 语音热路径（仅会话结束触发）。纯失败（如 LLM 抛错）MUST 不写幂等标记，以便下次重试。

#### Scenario: LLM 失败时安静跳过

- **WHEN** 蒸馏时 LLM `complete` 抛错
- **THEN** `reflect` 不抛错、不写回任何记忆，且不写幂等标记（允许下次重试）

#### Scenario: 无消息时跳过

- **WHEN** 对一个没有任何消息的会话调用 `reflect`
- **THEN** `reflect` 不调用 LLM、不写回、不抛错

#### Scenario: 解析失败时跳过

- **WHEN** LLM 返回无法解析为有效蒸馏结构的文本
- **THEN** `reflect` 不写回任何记忆、不抛错

### Requirement: 触发节奏可配置

沉淀的触发节奏 SHALL 外置为配置（行为即配置，§3.2），默认在"会话结束"触发。配置 MUST 允许关闭沉淀（等价 Noop 语义）。沉淀涉及的参数（高层 Q&A 上限、读取消息条数上限、沉淀种类、幂等键前缀、生成 token 上限等）MUST 全部外置，不得为 magic number。

#### Scenario: 默认会话结束触发

- **WHEN** 未做任何配置覆盖
- **THEN** 沉淀的触发节奏为"会话结束"

#### Scenario: 可关闭沉淀

- **WHEN** 配置将沉淀关闭
- **THEN** 会话结束不产生任何沉淀写回

