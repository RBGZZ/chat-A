# 设计：召回上下文窗口拼接（§5.5）

## 背景与约束

- 现状：`recall(query, limit?, pad?)` 返回离散 `MemoryRecord[]`；`messages` 表/数组带 `sessionId/turnId/role/content/createdAtMs`（SQLite 另有自增 `id`）；`snapshot` 取全局最近 N。
- 约束：**只改 `packages/memory/**`**；`recall` 现有签名/返回保持向后兼容；两实现（内存 + SQLite）同契约；确定性内核写 golden；N 外置配置；`exactOptionalPropertyTypes` 开。

## 关键决策

### 决策 1：纯加法用**新方法** `recallWithContext`，不动 `recall`

任务允许"给 `MemoryRecord` 加可选 `contextWindow?` 字段，或新增 `recallWithContext` 方法——选不破坏现有 recall 签名/返回的方式"。

选**新方法**而非给 `recall` 返回里塞 `contextWindow`，因为：

1. `recall` 是回合热路径，多数调用方（cognition 注入分桶）只要离散条目，不需要也不该为取窗付出代价；把窗口塞进 `recall` 返回会让所有现有消费者隐式多拿一份数据。
2. `MemoryRecord` 是"记忆条目"的纯数据形状，`contextWindow` 是"召回时算出的派生视图"，语义上不属于记忆本体——挂在返回包装类型 `RecalledMemory` 上更干净。
3. 新方法可独立演进取窗/锚定策略，不牵动 `recall` 的排序/强化契约。

`recallWithContext` **内部复用** `recall` 的全部召回+排序+检索即强化逻辑（不另起第二套打分），只在其结果上**追加**取窗，保证两路召回结果集/排序完全一致（单一权威）。

### 决策 2：时间戳就近锚定（零 schema 变更）

记忆条目当前**不存源消息行号**，无法精确指向某条 `messages`。给记忆表加"源消息 id"列虽更精确，但要 schema v5 迁移 + 改写路径，超出本切片范围（列在 Non-goals）。

本期用**时间戳就近**锚定：取 `messages` 里 `|createdAtMs − memory.createdAtMs|` 最小的那条为锚点（记忆形成时所处的对话时刻）。同距时取**较早**的一条（id/时序更小者）做确定性兜底。这是确定性、可 golden、对两实现一致的纯函数。

锚点定下后，按全局 `messages` 时序取**前 N + 锚点 + 后 N** 共 `2N+1` 条（不足则有几条取几条，边界自然收窄）。

> 为何按**全局** `messages` 时序而非按会话：与 `snapshot` 的全局最近 N 视图一致；记忆本体在 recall 返回里也不带 `sourceSession`，按会话隔离需额外信息。跨会话隔离窗口留 Non-goals。

### 决策 3：跨命中去重 + 稳定排序

多条命中各自取窗后窗口可能重叠（相邻记忆锚到相近消息）。每条命中**自身**的 `contextWindow` 是该命中独立的前后 N 条（含锚点）——保证每条记忆都拿到完整连贯片段。

但提供一个**去重的合并视图**给调用方按需用：把所有命中窗口里的消息按全局时序合并、同一条消息（按 SQLite `id` / 内存数组下标这一稳定身份）只保留一次。两实现用同一身份键（消息在全局时序里的稳定序号）去重，golden 一致。

为同时满足"每条命中拿到自己的连贯片段"与"跨命中去重不重复注入"，`RecalledMemory.contextWindow` 给**每条命中**的独立窗口；`recallWithContext` 的返回再附一个顶层 `mergedContext`（跨命中去重合并、全局时序）。调用方要连贯片段用前者、要去重总览用后者。

### 决策 4：窗口消息形状用 `ChatMessage`（与 `snapshot`/`messagesForSession` 一致）

窗口里每条是 `ChatMessage`（`{role, content}`），与 `snapshot`、`messagesForSession` 返回形状一致，便于调用方统一消费/注入。不额外暴露 `createdAtMs/turnId`（去重身份是实现内部细节，不外泄到返回类型）。

## 类型形状（纯加法）

```ts
/** 召回命中 + 其在对话时序里的上下文窗口（纯加法派生视图，§5.5）。 */
export interface RecalledMemory {
  readonly record: MemoryRecord;
  /** 命中记忆锚回 messages 时序后、前后各 N 条相邻消息（含锚点，按时序）。无相邻消息时为空数组。 */
  readonly contextWindow: readonly ChatMessage[];
}

/** recallWithContext 的返回:逐命中结果 + 跨命中去重的合并窗口。 */
export interface RecallWithContext {
  readonly memories: readonly RecalledMemory[];
  /** 所有命中窗口按全局时序合并、跨命中去重(同一条消息只一次)。 */
  readonly mergedContext: readonly ChatMessage[];
}

export interface RecallContextOptions {
  readonly limit?: number;
  readonly pad?: Pad;
  /** 前后各取条数 N;省略用配置 contextWindowSize。 */
  readonly windowSize?: number;
}
```

`MemoryStore` 新增：`recallWithContext(query: string, opts?: RecallContextOptions): RecallWithContext;`

## 取窗纯函数（config.ts 单一权威，两实现共用）

- `anchorIndex(messageTimestamps: readonly number[], memoryCreatedAtMs: number): number`——返回就近锚点在时序数组里的下标（同距取较早=较小下标）；空数组返回 -1。
- `windowRange(anchor: number, total: number, n: number): { start: number; end: number }`——返回 `[start, end)` 半开区间（`start=max(0, anchor−n)`、`end=min(total, anchor+n+1)`）；`anchor<0` 返回空区间。

两实现都：① 取出全局 `messages` 时序（内存即数组、SQLite `ORDER BY id`）；② 对每条命中用 `anchorIndex` + `windowRange` 切片；③ 合并视图按下标集合去重后按时序输出。SQLite 端用单次查询取全部消息时序（或带时间戳列），在 JS 层切窗，杜绝两后端 SQL/JS 两套逻辑漂移。

## 边界与降级

- 命中锚点在会话**首**：`start` 被夹到 0，只取锚点及其后 N 条。
- 命中锚点在会话**尾**：`end` 被夹到 total，只取锚点及其前 N 条。
- **N=0**：窗口只含锚点本身那一条（`2·0+1=1`）。
- 库内**无任何消息**：所有命中 `contextWindow=[]`、`mergedContext=[]`（不抛）。
- SQLite 读消息失败：`onError` 记录、该命中窗口降级为空、召回主结果仍返回（§3.2）。

## 测试策略

契约套件（两实现同跑）：取窗正确（前后各 N、含锚点）、跨命中去重（重叠窗口合并视图无重复且按时序）、边界（锚点在首/尾、N=0、空库）、窗口随时间戳就近锚定到正确消息、`recallWithContext` 的 `memories` 顺序与 `recall` 一致。注入固定时钟做确定性 golden。
