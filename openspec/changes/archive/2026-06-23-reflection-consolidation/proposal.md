## Why

小雪现在的记忆只有两条来源：滑窗 `snapshot`（短期、易滚出）与回合级 `LlmMemoryExtractor`（逐轮抽几条用户事实）。缺的是 canonical §5/§6.1 的**夜间沉淀（Reflection）**——会话结束后把整段对话**蒸馏**成"最显著的几条高层 Q&A"，并生成 **Agent 第一人称的自传/日记记忆**写回中期记忆。这正是"长期伴侣有自己的故事、记得我们一起经历过什么"的关键：逐轮抽取只攒碎片，沉淀才把碎片升格为"这次聊天的主旨"和"小雪自己的体验"。

没有沉淀，跨会话恢复时小雪只能靠零散关键词召回，拿不到"上次我们聊的核心是什么"，也没有第一人称连续性。Reflection 是 §5 三层记忆（短期/中期/长期）从"中期堆条目"走向"有层次蒸馏"的第一个雏形。

## What Changes

- **新增 `Reflector` 接缝**（`packages/memory`）：`reflect(sessionId): Promise<void>`，会话结束后**异步**把本会话对话蒸馏成几条高层记忆并写回 SQLite 中期记忆。
- **默认 Noop + LLM 默认实现**（沿用项目"接缝 + 默认关/降级"风格）：`NoopReflector`（默认，什么都不做）与 `LlmReflector`（complete + tolerantJsonParse + 失败降级，对齐 `LlmMemoryExtractor` 风格）。
- **两类沉淀写回**（经现有 `addMemory`，复用 ADD+去重）：高层 Q&A 用 `subject='shared'`（主用户与 Agent 的共同经历）；Agent 第一人称自传用 `subject='agent'`、`kind='reflection'`。
- **幂等去重**：用现有 `getState/setState`（kv_state）以 `diary_{sessionId}` 标记已沉淀；已生成则安静跳过，避免重复运行同会话重复写。
- **按会话查询消息**：新增 `MemoryStore.messagesForSession(sessionId, limit?)`，让 Reflector 拿到**本会话**完整消息（现有 `snapshot` 是全局最近 N，不按会话）。两实现（内存/SQLite）同契约。
- **触发节奏可配置**：默认"会话结束"触发；节奏外置为配置（行为即配置，§3.2）。
- **接线退出收尾**：`packages/client/src/cli.ts` 退出收尾处（`mem.store.close()` 之前）调用一次 `reflect`，失败吞掉不影响退出。
- **全程降级**：LLM 失败 / 无消息 / 解析失败 / 已幂等 都安静跳过，绝不抛。

## Capabilities

### New Capabilities
- `memory-reflection`: 会话结束的夜间沉淀能力——把整段会话蒸馏成几条高层 Q&A（`shared`）与 Agent 第一人称自传记忆（`agent`/`reflection`），经 ADD+去重写回 SQLite 中期记忆；幂等（按会话标记）、可配置触发、全程优雅降级；`Reflector` 接缝（Noop 默认 + LLM 实现）。

### Modified Capabilities
- `persistent-memory`: `MemoryStore` 契约**新增**按会话查询消息的方法 `messagesForSession`（向后兼容追加，不改既有方法签名），两实现同契约。

## Impact

- **canonical 章节/接缝**：§5（三层记忆，本次落 §6.1 Reflection 沉淀雏形：会话级蒸馏 + 第一人称自传）、§5.3（多主语：shared/agent 写回）、§5.8（ADD+去重复用）、§3.1（`Reflector` 接缝）、§3.2（行为即配置 / 优雅降级）。本次是 P1 子集：完整三层衰减/调和/向量仍归 P2。
- **代码**：新增 `packages/memory/src/reflector.ts`（`Reflector` 接缝 + `NoopReflector` + `LlmReflector` + 配置）；`MemoryStore` 接口与两实现新增 `messagesForSession`；`packages/client/src/cli.ts` 退出收尾接线一次 `reflect`。**仅改 `packages/memory/**` 与 `cli.ts`。**
- **延迟预算（§3.2）**：沉淀在**会话结束**触发，不进任何回合/语音热路径；一次 LLM `complete` 短调用，失败降级不阻塞退出。
- **测试**：Vitest 契约/golden + 降级用例（`InMemoryMemoryStore` + `FakeLlm`）覆盖：蒸馏写回两类主语、幂等跳过、无消息/解析失败/LLM 失败降级、`messagesForSession` 两实现一致。

## Non-goals

- 向量 / 语义检索、混合召回打分归一（§5.5，P2）。
- 三层记忆完整分层 + 统一衰减公式、长期记忆晋升（本次仅会话级沉淀雏形）。
- 离线双 Pass 调和的 update/delete、跨会话去重合并相似沉淀（§5.8，后续）。
- 真正的"夜间批处理 / 定时器调度"（本次只在会话结束同步触发一次；调度器留后续）。
- 改动 cognition/runtime/persona/providers/protocol 的任何文件（接线只动 cli.ts）。
