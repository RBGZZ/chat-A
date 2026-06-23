## 1. 接缝类型（packages/runtime）

- [ ] 1.1 在 `conversation.ts` 定义 `TurnStrategy { run(ctx: TurnContext): Promise<string> }`（异步、返回回复文本）
- [ ] 1.2 定义 `TurnContext { userText; onToken; turnId; correlationId; turnSpan; turnStartMs; deps: TurnDeps }`（外壳填充的回合上下文）
- [ ] 1.3 定义 `TurnDeps`（回合体所需只读依赖句柄：tracer/llm/memory/persona/sessionId + assembler/skeleton/stanceDetector/selfNotions/assertiveness/expressiveness/extractor/extractEnabled/traceSink）
- [ ] 1.4 从 `packages/runtime/src/index.ts` 导出上述类型（随 `export * from './conversation'`）

## 2. SingleShotStrategy（packages/runtime）

- [ ] 2.1 新增 `SingleShotStrategy implements TurnStrategy`，把现有 `send()` 回合体逐字迁入 `run(ctx)`：读心情 → 分歧检测 → 组装 prompt → `llm` 子 span 流式 → 收尾落库
- [ ] 2.2 把 helper `#composeSystem`/`#detectStance`/`#writeMemories`/`#recordTrace` 随回合体迁入策略，逻辑逐字保留，依赖改用 `ctx.deps`
- [ ] 2.3 策略经 `ctx.turnSpan` 设 `chat_a.emotion`/`chat_a.stance_notions`（位置与值与现状一致）
- [ ] 2.4 LLM 抛错沿用现状语义：策略内 `llm` span recordException+ERROR 后重抛，由外壳 catch 处理 `turn:end{error}`+turn span ERROR
- [ ] 2.5 回合内既有降级（召回/advance/extract/trace 吞错）原样保留（§3.2）

## 3. Conversation 外壳改造（packages/runtime）

- [ ] 3.1 `ConversationDeps` 新增可选 `strategy?: TurnStrategy`（exactOptionalPropertyTypes：条件展开，不显式赋 undefined）
- [ ] 3.2 构造期维持现有依赖装配，打包成 `TurnDeps` 存私有字段；`strategy = deps.strategy ?? new SingleShotStrategy()`
- [ ] 3.3 `send()` 退守外壳：建 turnId/correlationId → runWithCorrelation → `turn` span + `chat_a.*` 关联属性 → turnStartMs → emit `turn:start` → 组 `TurnContext` 调 `strategy.run(ctx)` → emit `turn:end{completed}`/span OK；catch emit `turn:end{error}`+span ERROR+rethrow；finally end
- [ ] 3.4 确认 `send(userText, onToken)` 签名、事件、trace 字段逐字不变；不改记忆/人格/trace 读写路径与 schema

## 4. 契约与接缝测试（Vitest，packages/runtime/test）

- [ ] 4.1 `SingleShotStrategy` 契约测试：不注入 strategy、FakeLlm 跑一轮，断言流式 token 拼回回复、emit 序 `['turn:start','turn:end']`、`correlationId` 正确（等价基线）
- [ ] 4.2 接缝测试：注入自定义 `TurnStrategy`（不调默认 LLM、返回自定义串/自定义 onToken）→ 返回值来自自定义策略、默认流程未执行，而外壳仍 emit `turn:start`/`turn:end` 且 correlationId 递增
- [ ] 4.3 现有 runtime 测试零改动全过（对外等价验收门）：conversation/persona-turn/decision-trace-turn/prompt-assembly/tracing/bus

## 5. 验收

- [ ] 5.1 worktree 根 `pnpm -r typecheck` 全绿
- [ ] 5.2 worktree 根 `npx vitest run` 全绿（含新测试 + 全部现有测试）
- [ ] 5.3 确认未改动 `packages/runtime` 以外任何包（client/cli 编译零改动）
