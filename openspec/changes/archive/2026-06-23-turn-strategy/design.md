## Context

`packages/runtime/src/conversation.ts` 的 `Conversation.send(userText, onToken)` 当前**焊死**一个单趟回合流程:

1. 建 `turnId`(`t${++seq}`)、`correlationId`(`${sessionId}/${turnId}/0`);
2. `bus.runWithCorrelation(correlationId, ...)` 内开 OTel `turn` span,设 `chat_a.*` 属性,emit `turn:start`;
3. 读心情 `persona.tone()`(回合前只读不改状态,保首字零额外延迟)→ 设 `chat_a.emotion`;
4. 分歧检测 `#detectStance(userText)` → 设 `chat_a.stance_notions`(降级吞错见 `#detectStance`);
5. 组装 prompt `#composeSystem(userText, mood.toneFragment, stance)` → `{ system, messages }` + `recalled`;
6. 开 `llm` 子 span,设 GenAI 属性,流式 `llm.stream` 累加并 `onToken`,OK/ERROR 状态,`finally` end;
7. 收尾(首字之后):`appendMessage`(user+assistant)、`persona.advance`(吞错)、`#writeMemories`、`#recordTrace`(吞错);
8. emit `turn:end{reason:'completed'}`,`turn` span OK;catch 分支 emit `turn:end{reason:'error'}` + span ERROR + rethrow;`finally` end。

canonical §9 P3 要做 **Agent loop**(模型 tool-use 多步循环),它是"回合怎么跑"的另一种实现,但生命周期/总线/correlationId/span 外壳与 single-shot 完全一致。继续把回合体焊死会迫使 P3 大改 `send()`(破坏对外契约)或旁路复制编排。按 §3.1 接缝原则,应把"回合体如何执行"抽成 `TurnStrategy` 接缝,现有流程逐字迁进 `SingleShotStrategy`,`Conversation` 退守外壳并委托。

约束(承 §3.1/§3.2):`Conversation` 公开 API 逐字不变(`ConversationDeps` 仅可加可选字段、`send` 签名/行为/事件/trace 字段不变),使 `packages/client/src/cli.ts` 与所有现有测试零改动通过;仅多一层委托,不增延迟;只改 `packages/runtime/**`。

## Goals / Non-Goals

**Goals:**
- 定义 `TurnStrategy` / `TurnContext` 接缝,把"一个回合具体怎么跑"与"回合生命周期/总线/correlationId/span/依赖装配"解耦。
- 现有焊死回合体**逐字搬进** `SingleShotStrategy.run()`,行为/事件/span/trace 全部不变(对外等价)。
- `Conversation` 保留外壳职责,把回合体委托给注入的 `TurnStrategy`(默认 `SingleShotStrategy`);`ConversationDeps` 加可选 `strategy?`。
- 公开契约逐字不变:契约测试 + 全部现有 runtime 测试零改动通过作为验收门。
- 留好 §9 P3 Agent loop 的挂载位(再实现一个 `TurnStrategy` 即可)。

**Non-Goals:**
- Agent loop / tool-use 多步策略实现(§9 P3 后续 change)。
- 打断、多策略动态选择、策略配置外置。
- 回合内任何行为变更(prompt/情绪/记忆/分歧/trace 逻辑原样)。

## Decisions

### D1：接缝形状 —— `TurnStrategy.run(ctx)` 返回 `Promise<string>`(回复文本)

```ts
export interface TurnStrategy {
  /** 执行一个回合体,返回最终回复文本。生命周期/总线/correlationId/turnSpan 由 Conversation 外壳负责。 */
  run(ctx: TurnContext): Promise<string>;
}
```

`run` 返回回复字符串,与 `send` 的返回值一致;**不**负责 emit `turn:start`/`turn:end`、不负责开 `turn` span(外壳的事)。策略只跑"回合体"——读心情、分歧、组装、流式、收尾落库。`turn:end{reason:'error'}` 与 `turn` span ERROR 在外壳的 catch 里发,故策略 `run` 抛错时由外壳兜住事件与 span 状态(与现状一致:现状 catch 在 `send` 顶层)。

**为何返回 `Promise<string>` 而非 emit 在策略内**:保证 `turn:start`/`turn:end` 的发出点、顺序、reason 与现状逐字一致——它们留在外壳,策略无从改变事件契约。**替代**(策略自己 emit turn:start/end)被否:把事件契约下放到策略,等价性难保证且 P3 易漂移。

### D2：`TurnContext` —— 携带外壳已建上下文 + 回合依赖句柄(经接缝,不暴露 Conversation 内部)

```ts
export interface TurnContext {
  readonly userText: string;
  readonly onToken: (token: string) => void;
  readonly turnId: string;          // 't1' ...
  readonly correlationId: string;   // 's1/t1/0'
  readonly turnSpan: Span;          // 外壳开的 turn span(@opentelemetry/api)
  readonly turnStartMs: number;     // turn:start 时间戳(latency 基线)
  readonly deps: TurnDeps;          // 回合体所需依赖(只读句柄)
}
```

`TurnDeps` 暴露回合体当前直接用到的依赖:`tracer`、`llm`、`memory`、`persona`、`sessionId`,以及现状 `#composeSystem`/`#detectStance`/`#writeMemories`/`#recordTrace` 所需的协作件(`assembler`/`skeleton`/`stanceDetector`/`selfNotions`/`assertiveness`/`expressiveness`/`extractor`/`extractEnabled`/`traceSink`)。这些原是 `Conversation` 私有字段;迁移时把回合体连同其 helper 方法一并搬入 `SingleShotStrategy`,`Conversation` 只在构造期把已装配好的依赖打包成 `TurnDeps` 传入策略。

**为何不把 `Conversation` 自身传入**:会让策略反向依赖外壳的全部公开/私有面,破坏接缝边界(§3.1)且循环。改为传一个**窄依赖包** `TurnDeps`(只读句柄),策略只拿它需要的。**为何 helper 方法(`#composeSystem` 等)随回合体迁入策略**:它们是回合体的私有实现细节,不属于外壳职责;迁入后逐字保留逻辑即等价。

### D3：依赖装配时机 —— `Conversation` 构造期建好 `TurnDeps` 与默认 `SingleShotStrategy`

`Conversation` 构造函数维持现有装配(默认值填充:memory/personaSeed/appraiser/personaStore/extractor/stanceDetector/traceSink/sessionId,建 `skeleton`/`assembler`/`persona` 等),装配完把不变的依赖打包成 `TurnDeps` 存为私有字段;`strategy = deps.strategy ?? new SingleShotStrategy()`。`send()` 每轮只建 per-turn 上下文(turnId/correlationId/turnSpan/turnStartMs),组成 `TurnContext` 调 `strategy.run(ctx)`。

**exactOptionalPropertyTypes**:`strategy?` 用条件展开装配(`deps.strategy ?? new SingleShotStrategy()`),`TurnDeps` 内可选协作件(如 appraiser/store 已在构造期解析为具体实例,不再可选)按需条件展开,绝不显式赋 `undefined`。

### D4：`send()` 外壳保留逐字一致的事件与 span 序

`send()` 重构后:
```
turnId/correlationId → runWithCorrelation → startActiveSpan('turn') → set chat_a.* attrs → turnStartMs=Date.now() → emit turn:start
try { reply = await strategy.run(ctx); emit turn:end{completed}; turnSpan OK; return reply }
catch { emit turn:end{error}; turnSpan recordException+ERROR; throw }
finally { turnSpan.end() }
```
注意:现状 `chat_a.emotion`/`chat_a.stance_notions` 是在回合体内设到 `turnSpan` 上的——迁入策略后,策略经 `ctx.turnSpan` 继续设这两个属性,**位置与值不变**。`chat_a.correlation_id`/`session_id`/`turn_id` 仍由外壳在 span 创建后立即设(与现状一致)。`turn:start` 的 `startedAtMs` = 外壳 `turnStartMs`;`turn:end` 的 `atMs` = `Date.now()`(completed/error 各自分支),与现状逐字一致。

### D5：默认注入 —— 不传 `strategy` 时行为与现状字节级一致

`ConversationDeps.strategy` 缺省时 `Conversation` 自建 `SingleShotStrategy`,回合体即迁移前逻辑,故所有现有测试(conversation/persona-turn/decision-trace-turn/prompt-assembly/tracing/bus)零改动通过。接缝测试另注入一个 `FakeTurnStrategy`(只 `onToken('x')` 并 emit 无关或返回固定串),断言 `Conversation` 外壳照常 emit `turn:start`/`turn:end`、`correlationId` 递增、但回合体被替换(LLM 未被调用 / 返回自定义串),证明委托生效。

## Risks / Trade-offs

- [重构破坏对外等价] → 验收门:全部现有 runtime 测试 + `packages/client` 编译零改动通过;新增 `SingleShotStrategy` 契约测试断言事件序/span 树/trace 字段/流式 token 与现状一致。若需改 cli 或别包才能编译 = 契约被破坏,停止。
- [回合体迁移漏搬一行致行为漂移] → 逐字搬运回合体与其 helper(`#composeSystem`/`#detectStance`/`#writeMemories`/`#recordTrace`)进策略,不改逻辑;decision-trace/persona-turn 测试覆盖 trace 字段与 tone/stance/posture,作为回归网。
- [`chat_a.emotion`/`stance_notions` 属性丢失或位置漂移] → 策略经 `ctx.turnSpan` 设同名属性同值;tracing 测试断言 `chat_a.*` 属性存在。
- [策略 `run` 抛错时事件契约漂移] → 错误路径事件(`turn:end{error}`+span ERROR)留在外壳 catch,与现状同点发出;tracing 的 LLM 出错用例验证。
- [延迟回归] → 仅多一层方法委托,无新增 I/O/await,首字与回合延迟不变(§3.2)。

## Migration Plan

纯接缝化重构,无 schema / 持久化变更,无数据迁移,作用域仅 `packages/runtime/**`。落地顺序:① 在 `conversation.ts` 定义 `TurnStrategy`/`TurnContext`/`TurnDeps` 类型;② 实现 `SingleShotStrategy`(把现有回合体 + helper 逐字迁入,helper 改用 `ctx.deps`);③ `Conversation` 构造期装配 `TurnDeps` + 默认策略,`send()` 退守外壳 + 委托;④ index 导出;⑤ 跑全部现有 runtime 测试(零改动)+ 新契约/接缝测试 + `pnpm -r typecheck`。回滚 = 把回合体搬回 `send()`(策略为新增、不被其它模块依赖,移除无连带)。
