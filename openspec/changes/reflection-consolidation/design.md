## Context

动机与需求见 `proposal.md` 与 `specs/memory-reflection/spec.md`。现有记忆写路径只有两处：滑窗 `snapshot`（全局最近 N，会滚出）与回合级 `LlmMemoryExtractor`（逐轮抽用户事实）。canonical §6.1 要求会话结束做 Reflection：把整段对话蒸馏成少数高层记忆 + Agent 第一人称自传，写回中期记忆。

约束（承 §3.1/§3.2）：跨模块只依赖类型化接口；确定性内核写 golden/契约 test；沉淀不进回合/语音热路径；行为参数全外置；外部依赖（LLM）失败一律降级不崩；**纯 SQLite + LLM，绝不依赖向量库**。边界约束：本切片只允许动 `packages/memory/**` 与 `packages/client/src/cli.ts`。

## Goals / Non-Goals

**Goals:**
- 新增 `Reflector` 接缝：`reflect(sessionId): Promise<void>`，会话结束蒸馏写回。
- `LlmReflector`（complete + tolerantJsonParse + 失败降级，对齐 `LlmMemoryExtractor`）与 `NoopReflector`（默认）。
- 两类沉淀经现有 `addMemory` 写回：高层 Q&A `subject='shared'`；第一人称自传 `subject='agent'` + `kind='reflection'`，复用 ADD+去重。
- 幂等：`getState/setState` 以 `diary_{sessionId}` 标记，已沉淀则跳过。
- `MemoryStore` 新增 `messagesForSession(sessionId, limit?)`，两实现同契约。
- 触发节奏可配置，默认"会话结束"。

**Non-Goals:**（详见 proposal Non-goals）
- 向量/语义检索、混合召回（P2）。
- 三层完整衰减/长期晋升/调和合并相似沉淀。
- 真·定时夜间批处理调度器（本次会话结束同步触发一次）。

## Decisions

### D1. `Reflector` 接缝 = 独立文件 `packages/memory/src/reflector.ts`，对齐 extractor 风格
- 接口：`interface Reflector { reflect(sessionId: string): Promise<void>; }`——返回 `void`：沉淀是**副作用写回**（经注入的 `MemoryStore.addMemory`），不像 `MemoryExtractor` 把待写项返回给调用方。理由：沉淀触发点（会话结束）与回合写路径不同，调用方（cli）只想"触发一次、别崩"，不关心写了几条。
- 默认 `NoopReflector`（`reflect` 直接 resolve），沿用"接缝 + 默认关"风格；`LlmReflector` 为真实现。
- 复用 `@chat-a/providers` 的 `LlmProvider.complete` + `tolerantJsonParse`，错误回调 `onError?`（与 `LlmMemoryExtractor` 完全一致的容错骨架）。

### D2. 幂等键 = `diary_{sessionId}`，存 kv_state
- `reflect` 进入即 `getState('diary_' + sessionId)`：非空 → 已沉淀，安静 return（不重复写、不调 LLM）。
- 成功写回后 `setState('diary_' + sessionId, <时间戳/计数 JSON>)` 标记完成。
- 为何选 kv_state 而非查 memories：沉淀经 `addMemory` 去重，但"是否已为此会话沉淀过"是会话级布尔事实，kv 是单一权威、O(1)、与 persona 状态同机制（决策 5 行为即配置）。键前缀 `diary_` 外置为配置常量，避免散落字符串。

### D3. 新增 `MemoryStore.messagesForSession(sessionId, limit?)`
- 现有 `snapshot(limit)` 是**全局**最近 N，跨会话混合，不能用于"只蒸馏本会话"。Reflector 需要会话隔离的消息。
- 签名：`messagesForSession(sessionId: string, limit?: number): readonly ChatMessage[]`（同步，与其余读方法一致；limit 省略用配置 `reflectionMessageLimit`）。
- SQLite 实现：`WHERE session_id = ? ORDER BY id DESC LIMIT ? ` 再 `reverse()`（时序正序），读失败降级空，复用 `#onError`。
- 内存实现：按 `sessionId` 过滤 `#messages` 取最近 N。
- 向后兼容：纯**追加**方法，不改既有签名；契约套件加一条断言两实现一致。

### D4. 蒸馏 prompt 与解析:一次 complete 拿"高层 Q&A[] + 第一人称自传"
- prompt 让模型读整段会话，输出 JSON：`{ "highlights": [{"q":"...","a":"..."}], "diary": "小雪第一人称的一段..." }`。
- 解析（tolerantJsonParse + 字段校验，丢弃非法）：
  - `highlights` 每项 → `addMemory({ text: "Q：… A：…", kind: 'reflection', subject: 'shared' })`，上限 `maxHighlights`（防失控）。
  - `diary` 非空字符串 → `addMemory({ text: diary, kind: 'reflection', subject: 'agent' })`（agent 主语不关联人）。
- 去重交给 `addMemory`（规范化文本相等即累加 hits 不增行），与 extractor 同语义；重复运行（若绕过幂等）也不产生重复行。
- exactOptionalPropertyTypes：可选字段用条件展开，不显式赋 `undefined`。

### D5. 全程降级（绝不抛）
- 失败/降级路径：库读不到消息（空数组）→ 跳过；消息为空 → 跳过；LLM `complete` 抛 → `onError` + 跳过；`tolerantJsonParse` 返回 null 或字段全非法 → 跳过；已幂等 → 跳过。
- 任一路径都不写幂等标记**除非**确实有写回或确实判定"本会话已处理"。为简单与幂等稳定：只在**至少成功写回一条**后打标记；纯失败不打标记，下次启动可重试（与"绝不丢沉淀机会"一致）。无消息这种"确定性空"也不打标记（下次有消息再试）。
- cli 接线：`await reflector.reflect(sessionId).catch(() => {})`，再 `mem.store.close()`；reflect 内部已吞错，catch 仅兜底。

### D6. 配置（行为即配置，§3.2）
- `ReflectionConfig`：`enabled`（触发节奏雏形：默认 `'session-end'`，可设 `'off'` 即用 Noop 语义）、`maxHighlights`、`reflectionMessageLimit`、`maxTokens`、`diaryStateKeyPrefix='diary_'`、`reflectionKind='reflection'`。全外置默认值，无 magic number。
- cli 经 env 决定用 `LlmReflector` 还是 `NoopReflector`（默认 Noop，对齐"默认关"；`CHAT_A_REFLECTION=llm` 开）。

## Risks / Trade-offs
- **会话结束多写一次 LLM 调用**：仅会话结束一次、默认关、失败降级，不进热路径——可接受。
- **`messagesForSession` 改 `MemoryStore` 契约**：纯追加方法、两实现同步落地、契约测试覆盖；属 persistent-memory 的 MODIFIED（向后兼容）。
- **sessionId 来源**：cli 当前未显式持有 sessionId。接线时从 conversation/已落库消息推导或用固定/生成 id；只在 cli.ts 内解决，不外溢。

## Migration
- 无 schema 变更：复用既有 `messages` / `memories` / `kv_state` 表与当前 `CURRENT_SCHEMA_VERSION`。`messagesForSession` 只读既有 `messages.session_id` 列；幂等标记走既有 kv_state。无迁移步骤。
