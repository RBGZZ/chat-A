## 1. MemoryStore 按会话取消息

- [x] 1.1 `MemoryStore` 接口新增 `messagesForSession(sessionId, limit?): readonly ChatMessage[]`（同步签名，向后兼容追加）。
- [x] 1.2 `MemoryConfig` 新增 `reflectionMessageLimit` 默认值（外置，§3.2）。
- [x] 1.3 `InMemoryMemoryStore.messagesForSession`：按 sessionId 过滤取最近 N（默认配置上限），时序正序。
- [x] 1.4 `SqliteMemoryStore.messagesForSession`：`WHERE session_id=? ORDER BY id DESC LIMIT ?` 再 reverse；读失败 onError + 降级空。
- [x] 1.5 契约套件加断言：两实现 `messagesForSession` 只返回该会话、按时序、受上限约束。

## 2. Reflector 接缝与配置

- [x] 2.1 新增 `packages/memory/src/reflector.ts`：`interface Reflector { reflect(sessionId): Promise<void> }`。
- [x] 2.2 `ReflectionConfig` + 默认值：`enabled('session-end'|'off')`、`maxHighlights`、`maxTokens`、`diaryStateKeyPrefix='diary_'`、`reflectionKind='reflection'`、`messageLimit`（全外置，无 magic number）。
- [x] 2.3 `NoopReflector`：`reflect` 直接 resolve，不写库。

## 3. LlmReflector 实现

- [x] 3.1 幂等:进入 `reflect` 即查 `getState(prefix+sessionId)`,非空则跳过。
- [x] 3.2 取本会话消息 `messagesForSession`;为空则跳过(不调 LLM、不打标记)。
- [x] 3.3 构造蒸馏 prompt(读整段会话 → 输出 highlights[] + diary),`complete` + `tolerantJsonParse`(对齐 extractor 容错骨架)。
- [x] 3.4 校验解析:highlights 每项(q/a)→ `addMemory({text, kind:reflection, subject:'shared'})`,上限 maxHighlights;diary 非空 → `addMemory({text:diary, kind:reflection, subject:'agent'})`;非法/空丢弃。
- [x] 3.5 仅在成功写回 ≥1 条后 `setState(prefix+sessionId, ...)` 打标记。
- [x] 3.6 全程降级:LLM 抛/解析失败/字段全非法 → onError + 安静跳过,纯失败不打标记。
- [x] 3.7 `index.ts` 导出 `reflector` 模块。

## 4. 测试(契约/golden + 降级)

- [x] 4.1 Noop 不写库、不抛。
- [x] 4.2 LlmReflector + FakeLlm(罐装 JSON):蒸馏写回 shared 高层 Q&A + agent 第一人称,均可召回。
- [x] 4.3 高层 Q&A 受 maxHighlights 上限约束。
- [x] 4.4 写回去重:与既有等价 → 不增行。
- [x] 4.5 幂等:同 sessionId 二次 reflect 不再调 LLM、不增行(用计数 FakeLlm 或 spy)。
- [x] 4.6 无消息 → 跳过、不调 LLM、不打标记。
- [x] 4.7 LLM 失败(FakeLlm complete 抛)→ 不抛、不写回、不打标记。
- [x] 4.8 解析失败(乱码)→ 不写回、不抛。
- [x] 4.9 enabled='off' 等价 Noop 语义。

## 5. 接线到 cli 退出收尾

- [x] 5.1 `packages/client/src/cli.ts`:按 env(`CHAT_A_REFLECTION=llm` 默认 off)装配 Reflector(默认 Noop)。
- [x] 5.2 退出收尾、`mem.store.close()` 之前调用一次 `reflect(sessionId)`,`.catch(()=>{})` 兜底吞错。
- [x] 5.3 sessionId 仅在 cli.ts 内解决(生成/推导),不外溢。

## 6. 验收

- [x] 6.1 `openspec validate "reflection-consolidation"` 通过。
- [x] 6.2 worktree 根 `pnpm -r typecheck` 全绿。
- [x] 6.3 worktree 根 `npx vitest run` 全绿。
