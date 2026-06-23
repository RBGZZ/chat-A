# c2b 语义召回接线（非阻塞）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Embedder 接进回合召回——query 异步嵌入(有界等待 + LRU 缓存)后传进 `recallHybrid`,写侧后台嵌入,全程不阻塞首字。

**Architecture:** 编排层(runtime 策略)在回合前与已有的 `detectStance` await **并行**起跑 query 嵌入(`embedQueryBudgeted`,超时/失败→null),把 `queryVector` 传进**同步** `composeSystem→recallHybrid`;无 embedder/超时→退回关键词快路径。回合收尾后台嵌入新记忆 `setEmbedding`。决策 trace 记语义元数据。

**Tech Stack:** TypeScript(strict + exactOptionalPropertyTypes)、ESM、pnpm workspaces、Vitest。

## Global Constraints
- TS strict,**exactOptionalPropertyTypes**:可选字段绝不显式 `undefined`,条件展开/省略。
- 注释中文;每包 `pnpm -F @chat-a/<pkg> typecheck` 与 `test` 全绿。
- **非阻塞硬约束(§5.5)**:关键词快路径永远先返回;query 嵌入异步、**绝不进同步 `recall`/首字临界路径**;超时/失败/无 embedder → 退快路径;写侧嵌入后台 fire-and-forget。
- 已就位接口(勿改其签名):memory `recallHybrid(query, { queryVector?, limit?, pad?, kindOptions? }): readonly MemoryRecord[]`、`setEmbedding(id, vector)`、`addMemory(...)→ number`、`memoriesNeedingEmbedding(limit?)→{id,text}[]`;providers `Embedder { embed(texts, signal?): Promise<number[][]>; dimension; id }`、`createEmbedder(config)`、`loadEmbedderConfig(env)`。

---

## 执行结构(并行 / 串行)
- **并行**:Task 1(runtime 新文件 `query-embed.ts`)、Task 2(observability 决策trace 语义字段)。两域不相交。
- **串行**:Task 3(runtime 焦点接线,消费 1+2)→ Task 4(client cli 注入 embedder)。

---

## Task 1: runtime — `embedQueryBudgeted` + LRU 缓存（新文件,可并行）

**Files:**
- Create: `packages/runtime/src/query-embed.ts`
- Test: `packages/runtime/test/query-embed.test.ts`

**Interfaces:**
- Produces:
  - `interface QueryEmbedResult { vector: number[] | null; latencyMs: number; timedOut: boolean; cacheHit: boolean }`
  - `interface QueryEmbedOptions { budgetMs?: number; cacheSize?: number; now?: () => number }`(`budgetMs` 默认 120;`cacheSize` 默认 256;`now` 注入便于测试)
  - `class QueryEmbedder { constructor(embedder: Embedder, opts?: QueryEmbedOptions); embed(text: string): Promise<QueryEmbedResult>; }` —— LRU 缓存(key=`${embedder.id}::${text}`);未命中则 `embedder.embed([text], signal)` 配 `AbortController` + `budgetMs` 超时;超时/抛错 → `{vector:null, timedOut/false, cacheHit:false}` 且**后台让 embed 跑完写入缓存**(下次命中);命中 → 立即返回缓存向量 `cacheHit:true`。绝不抛。

- [ ] **Step 1: 写失败测试**。`packages/runtime/test/query-embed.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Embedder } from '@chat-a/providers';
import { QueryEmbedder } from '../src/query-embed';

function fakeEmbedder(impl: (t: string) => Promise<number[]>): Embedder {
  return { id: 'fake', dimension: 3, embed: async (texts) => [await impl(texts[0]!)] };
}

describe('runtime/QueryEmbedder（非阻塞 query 嵌入）', () => {
  it('正常:返回向量,cacheHit=false', async () => {
    const qe = new QueryEmbedder(fakeEmbedder(async () => [1, 2, 3]));
    const r = await qe.embed('hi');
    expect(r.vector).toEqual([1, 2, 3]);
    expect(r.cacheHit).toBe(false);
    expect(r.timedOut).toBe(false);
  });
  it('缓存命中:第二次同 query 直接命中', async () => {
    const spy = vi.fn(async () => [1, 2, 3]);
    const qe = new QueryEmbedder(fakeEmbedder(spy));
    await qe.embed('x');
    const r2 = await qe.embed('x');
    expect(r2.cacheHit).toBe(true);
    expect(r2.vector).toEqual([1, 2, 3]);
    expect(spy).toHaveBeenCalledTimes(1);
  });
  it('超时:超 budgetMs → vector=null, timedOut=true,不抛', async () => {
    const slow = fakeEmbedder(() => new Promise((res) => setTimeout(() => res([9]), 1000)));
    const qe = new QueryEmbedder(slow, { budgetMs: 10 });
    const r = await qe.embed('slow');
    expect(r.vector).toBeNull();
    expect(r.timedOut).toBe(true);
  });
  it('embed 抛错 → vector=null,不抛', async () => {
    const bad = fakeEmbedder(() => Promise.reject(new Error('boom')));
    const qe = new QueryEmbedder(bad, { budgetMs: 50 });
    const r = await qe.embed('e');
    expect(r.vector).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**。`pnpm -F @chat-a/runtime test query-embed`,Expected: FAIL(`QueryEmbedder` 未定义)。
- [ ] **Step 3: 实现 `query-embed.ts`**。

```ts
import type { Embedder } from '@chat-a/providers';

/** query 嵌入结果(承 §5.5 非阻塞):vector=null 表示本轮不用语义(退关键词快路径)。 */
export interface QueryEmbedResult {
  readonly vector: number[] | null;
  readonly latencyMs: number;
  readonly timedOut: boolean;
  readonly cacheHit: boolean;
}

export interface QueryEmbedOptions {
  /** 有界等待预算(ms);默认 120;设 0=只用缓存绝不等(承 §5.7b)。 */
  readonly budgetMs?: number;
  /** LRU 缓存条数;默认 256。 */
  readonly cacheSize?: number;
  /** 注入时钟(测试);默认 Date.now。 */
  readonly now?: () => number;
}

/**
 * 非阻塞 query 嵌入(§5.5/§5.7b):LRU 缓存 + 超时预算 + AbortController;
 * 绝不抛、超时/失败→null(退关键词快路径),后台跑完写缓存供下次命中。
 */
export class QueryEmbedder {
  readonly #embedder: Embedder;
  readonly #budgetMs: number;
  readonly #cacheSize: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, number[]>(); // 插入序即 LRU 序

  constructor(embedder: Embedder, opts?: QueryEmbedOptions) {
    this.#embedder = embedder;
    this.#budgetMs = opts?.budgetMs ?? 120;
    this.#cacheSize = opts?.cacheSize ?? 256;
    this.#now = opts?.now ?? Date.now;
  }

  async embed(text: string): Promise<QueryEmbedResult> {
    const start = this.#now();
    const key = `${this.#embedder.id}::${text}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, cached); // 触达刷新 LRU
      return { vector: cached, latencyMs: 0, timedOut: false, cacheHit: true };
    }
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => { ac.abort(); resolve('timeout'); }, this.#budgetMs);
    });
    const run = this.#embedder
      .embed([text], ac.signal)
      .then((vs) => { const v = vs[0]; if (v !== undefined) this.#put(key, v); return v ?? null; })
      .catch(() => null);
    try {
      const winner = await Promise.race([run, timeout]);
      const latencyMs = this.#now() - start;
      if (winner === 'timeout') return { vector: null, latencyMs, timedOut: true, cacheHit: false };
      return { vector: winner, latencyMs, timedOut: false, cacheHit: false };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #put(key: string, v: number[]): void {
    this.#cache.set(key, v);
    while (this.#cache.size > this.#cacheSize) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}
```
并在 `packages/runtime/src/index.ts` 追加 `export * from './query-embed';`。

- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test query-embed`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/query-embed.ts packages/runtime/test/query-embed.test.ts packages/runtime/src/index.ts
git commit -m "feat(runtime): QueryEmbedder 非阻塞 query 嵌入(LRU+超时+abort,§5.5/§5.7b)"
```

---

## Task 2: observability — 决策trace 语义召回字段（可并行）

**Files:**
- Modify: `packages/observability/src/decision-trace.ts`(DecisionTrace 记录类型)
- Modify: `packages/observability/src/sqlite-decision-trace.ts`(schema + 写入)
- Test: `packages/observability/test/decision-trace.test.ts`

**Interfaces:**
- Produces: `DecisionTrace` 记录新增**可选**字段 `semanticUsed?: boolean`、`embedLatencyMs?: number`、`embedTimedOut?: boolean`、`embedCacheHit?: boolean`(纯加法,缺省=不写)。SQLite 加对应列(可空),写入时条件展开。

- [ ] **Step 1: 写失败测试**。在 `packages/observability/test/decision-trace.test.ts` 加:

```ts
it('记录可带语义召回元数据(向后兼容:省略不写)', () => {
  const path = tmpDb();                 // 复用文件内既有临时库 helper
  const sink = new SqliteDecisionTraceSink({ path });
  sink.record({ ...baseRecord(), semanticUsed: true, embedLatencyMs: 42, embedTimedOut: false, embedCacheHit: true });
  sink.record(baseRecord());            // 不带语义字段:不应报错
  sink.close();
  const reader = new DecisionTraceReader({ path });
  const rows = reader.recent(10);
  expect(rows.find((r) => r.semanticUsed === true)?.embedLatencyMs).toBe(42);
  reader.close();
});
```
> `baseRecord()`/`tmpDb()` 用文件内既有同款 helper;若无 `baseRecord` 则内联一个最小合法记录(对齐既有 record 字段)。

- [ ] **Step 2: 运行确认失败**。`npx vitest run packages/observability -t 语义`,Expected: FAIL(字段未知/列不存在)。
- [ ] **Step 3: 实现**。
  - `decision-trace.ts`:`DecisionTrace`(或 record 入参类型)加 4 个可选字段(中文注释:语义召回元数据,§5.5/§8.1)。
  - `sqlite-decision-trace.ts`:`MIGRATIONS` 加一版 `ALTER TABLE decision_trace ADD COLUMN semantic_used INTEGER;`(及 embed_latency_ms REAL / embed_timed_out INTEGER / embed_cache_hit INTEGER),bump `CURRENT_SCHEMA_VERSION`;`record` 写入用条件展开(布尔存 0/1,缺省存 NULL)。`decision-trace-reader.ts` 行映射回这些可选字段(0/1→bool,NULL→省略)。
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/observability typecheck && npx vitest run packages/observability`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/observability/src/decision-trace.ts packages/observability/src/sqlite-decision-trace.ts packages/observability/src/decision-trace-reader.ts packages/observability/test/decision-trace.test.ts
git commit -m "feat(observability): 决策trace 语义召回字段(semanticUsed/embedLatencyMs/timedOut/cacheHit,纯加法)"
```

---

## Task 3: runtime — 焦点接线（串行,消费 Task 1+2）

**Files:**
- Modify: `packages/runtime/src/conversation.ts`(ConversationDeps/TurnDeps 注入 embedder+QueryEmbedder;两策略接线)
- Modify: `packages/runtime/src/turn-shared.ts`(composeSystem 传 queryVector→recallHybrid;finalizeTurn 后台写侧嵌入 + trace 字段)
- Modify: `packages/runtime/src/tool-calling-strategy.ts`(同 SingleShot 接线)
- Test: `packages/runtime/test/semantic-recall-wiring.test.ts`

**Interfaces:**
- Consumes: `QueryEmbedder`(Task1)、`recallHybrid`/`setEmbedding`/`memoriesNeedingEmbedding`(memory)、`DecisionTrace` 语义字段(Task2)。
- Produces: 回合行为——有 embedder 时回合前并行嵌入 query、传 `queryVector` 进 `recallHybrid`;无/超时退快路径;收尾后台嵌入新记忆;trace 记语义元数据。

- [ ] **Step 1: 写失败测试**。`packages/runtime/test/semantic-recall-wiring.test.ts`:用 fake embedder + 监视用 memory(记录 recallHybrid 的 opts、setEmbedding 调用)+ recording traceSink,跑一回合,断言:① 注入 embedder 时 `recallHybrid` 收到非空 `queryVector`;② trace `semanticUsed=true`;③ 收尾调用了 `setEmbedding`(后台写侧);④ **不注入 embedder 时** `recall`/`recallHybrid` 走关键词(queryVector 省略)、trace `semanticUsed` 省略/false、回合正常。(沿用 `closeness-wiring.test.ts` 的 fake-deps/recordingSink 风格。)
- [ ] **Step 2: 运行确认失败**。`pnpm -F @chat-a/runtime test semantic-recall`,Expected: FAIL。
- [ ] **Step 3: 实现**。
  - `conversation.ts`:`ConversationDeps` 加 `readonly embedder?: Embedder;` 与可选 `readonly queryEmbed?: QueryEmbedOptions;`(注释:缺省=关闭语义=与今天一致)。构造期:`const queryEmbedder = deps.embedder ? new QueryEmbedder(deps.embedder, deps.queryEmbed) : undefined;`,放入 `TurnDeps`(加 `readonly queryEmbedder?: QueryEmbedder;`)。
  - 两策略 `run`(SingleShot + ToolCalling)在 `detectStance` **之前**起跑、之后 await(并行重叠):
    ```ts
    const embedP = deps.queryEmbedder ? deps.queryEmbedder.embed(userText) : null;
    const stance = await detectStance(deps, userText);
    const qe = embedP ? await embedP : null;          // QueryEmbedResult | null
    const { assembled, recalled } = composeSystem(deps, userText, mood.toneFragment, stance, qe?.vector ?? undefined);
    ```
    并把 `qe`(latency/timedOut/cacheHit/vector)透传给 `finalizeTurn`(新增可选入参 `semantic?`)。
  - `turn-shared.ts` `composeSystem`:签名加末参 `queryVector?: number[]`;内部 `recalled = queryVector !== undefined ? deps.memory.recallHybrid(userText, { queryVector }) : deps.memory.recall(userText);`(其余 assemble 不变;失败兜底空数组同现状)。
  - `turn-shared.ts` `finalizeTurn`:`args` 加可选 `semantic?: { vector: number[] | null; latencyMs: number; timedOut: boolean; cacheHit: boolean }`;
    - 写侧后台嵌入(回复之后、**fire-and-forget 不 await**,§5.5):
      ```ts
      if (deps.queryEmbedder !== undefined && deps.embedder !== undefined) {
        const pending = deps.memory.memoriesNeedingEmbedding(8);
        void Promise.allSettled(pending.map(async (m) => {
          try { const [v] = await deps.embedder!.embed([m.text]); if (v) deps.memory.setEmbedding(m.id, v); } catch { /* 后台嵌入失败本轮跳过 */ }
        }));
      }
      ```
      (注:`deps.embedder` 也需进 TurnDeps;或经 queryEmbedder 暴露 embedder。简化:TurnDeps 同时带 `embedder?`。)
    - trace `record` 条件展开加 `...(args.semantic ? { semanticUsed: args.semantic.vector !== null, embedLatencyMs: args.semantic.latencyMs, embedTimedOut: args.semantic.timedOut, embedCacheHit: args.semantic.cacheHit } : {})`。
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test`,Expected: PASS(含既有回合测试无回归)。
- [ ] **Step 5: 全仓校验 + Commit**

```bash
pnpm -r typecheck && pnpm -r test
git add packages/runtime/src/conversation.ts packages/runtime/src/turn-shared.ts packages/runtime/src/tool-calling-strategy.ts packages/runtime/test/semantic-recall-wiring.test.ts
git commit -m "feat(runtime): c2b 语义召回接线(非阻塞)— query 异步嵌入并行重叠+recallHybrid+后台写侧嵌入+trace"
```

---

## Task 4: client — cli 注入 embedder（串行,可选启用）

**Files:**
- Modify: `packages/client/src/cli.ts`(从 env 建 embedder 传入 Conversation)
- Modify: `start.bat` / `persona.example.yaml`(文档化 env 开关)

**Interfaces:**
- Consumes: `createEmbedder`/`loadEmbedderConfig`(providers)、`ConversationDeps.embedder`(Task3)。

- [ ] **Step 1: 接线**。`cli.ts`:`const embedderCfg = loadEmbedderConfig(process.env);` → `const embedder = createEmbedder(embedderCfg);` 传入 `new Conversation({ ..., embedder })`。**默认行为**:`loadEmbedderConfig` 缺关键配置时降级 hash embedder(已实现)——为保持"默认纯关键词、零额外开销",仅当显式设了 `CHAT_A_EMBEDDER`/embedding env 时才注入(否则不传 embedder,走快路径)。在 `start.bat` 注释新增 `CHAT_A_EMBEDDER`/`CHAT_A_QUERY_EMBED_BUDGET_MS` 说明。
- [ ] **Step 2: 手测**。设 `CHAT_A_EMBEDDER=hash` 跑 `pnpm dev`,与小雪对话一轮,确认正常回复(语义路启用、hash 兜底);不设则与今天一致。
- [ ] **Step 3: Commit**

```bash
git add packages/client/src/cli.ts start.bat persona.example.yaml
git commit -m "feat(client): cli 可选注入 embedder 启用语义召回(默认关,env CHAT_A_EMBEDDER)"
```

---

## 自查(对照 §5.7b / §5.5)
- **覆盖**:embedQueryBudgeted(LRU/超时/abort)→Task1;trace 字段→Task2;注入+并行重叠+recallHybrid+后台写侧→Task3;cli 启用→Task4。✅
- **非阻塞**:query 嵌入在 detectStance 并行、有界、超时→null 退快路径(Task3 Step3);composeSystem 仍**同步**、queryVector 在调用前算好;写侧 fire-and-forget。✅
- **降级**:无 embedder/超时/抛错→关键词快路径,逐层不抛(Task1 catch + Task3 分支)。✅
- **类型一致**:`QueryEmbedResult`/`QueryEmbedder.embed`(Task1)被 Task3 消费;`recallHybrid({queryVector})`/`setEmbedding`/`memoriesNeedingEmbedding`(memory 既有)签名一致;trace 4 字段(Task2 定义)Task3 写入。✅
- **占位符**:无 TBD;各 code 步有测试+实现代码。
- **并行/串行**:Task1(runtime 新文件)∥ Task2(observability)→ Task3(runtime 焦点)→ Task4(client)。Task1 与 Task3 同包但不同文件(query-embed.ts vs conversation/turn-shared),Task3 import Task1 故串行其后。
