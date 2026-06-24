# Tasks: companion-coherence-wiring

## 1. 自我一致性 Guard 接进回合流程(runtime)

- [x] 1.1 `packages/runtime/src/conversation.ts`:`ConversationDeps` + `TurnDeps` 新增可选 `selfConsistencyGuard?: SelfConsistencyGuard`(来自 `@chat-a/persona`);`TurnDeps` 新增 `agentName`(构造期从 seed 取)。装配时仅在提供 Guard 时填(exactOptionalPropertyTypes 友好)。
- [x] 1.2 `conversation.ts`:`PromptAssembler` 注册 `ReAnchorContributor`(来自 `@chat-a/cognition`),追加在 `DissentContributor` 之后(priority 已是 reAnchor 压轴);无 anchor 时它返回 null → 默认路径零注入。
- [x] 1.3 `conversation.ts`:`Conversation` 外壳新增进程内 `#pendingAnchor?: AnchorInput`;每轮把当前 `#pendingAnchor` 经 `TurnContext.pendingAnchor` 透传给策略;`finalizeTurn` 经注入回调 `setPendingAnchor` 写回外壳本轮 Guard 结论(drift→`AnchorInput`,否则清空)。**透传一次性**:用过即清(下轮起始读到后置空)。
- [x] 1.4 `conversation.ts` `SingleShotStrategy.run`:把 `ctx.pendingAnchor` 透传进 `composeSystem`(填 `PromptContext.anchor`)。
- [x] 1.5 `packages/runtime/src/turn-shared.ts`:`composeSystem` 新增可选 `anchor?: AnchorInput` 入参,填进 `assembler.assemble({ …, anchor })`;缺省不填(等价现状)。
- [x] 1.6 `turn-shared.ts` `finalizeTurn`:若 `deps.selfConsistencyGuard` 存在 → 从本轮 `recalled` 筛 `subject==='agent'` 映射 `SelfMemoryRef[]`(`core = memoryKind==='core' || pinned===true`),调 `guard.check({ reply, selfMemories, agentName })`;按 `drift` 经 `setPendingAnchor` 回调写回外壳。try/catch 降级不锚定不崩(§3.2)。不注入 Guard → 整段跳过(零开销)。
- [x] 1.7 `finalizeTurn` 的 args 加可选 `setPendingAnchor?(a: AnchorInput | undefined): void`;`SingleShotStrategy` 与 `ToolCallingStrategy` 共用(turn-shared 复用,两策略零漂移)。

## 2. 自我一致性 Guard 装配(persona helper + client)

- [x] 2.1 `packages/persona/src/self-consistency.ts`(或新增 `self-consistency-factory.ts`,纯加法):导出 `createSelfConsistencyGuard(mode, opts)`——`mode: 'off'|'on'|'llm'`;`on`→`DefaultSelfConsistencyGuard({ config:{ enabled:true, strictness:'core-only' }, onDecision })`;`llm`→`LlmSelfConsistencyGuard({ provider, config:{ enabled:true, … }, onDecision, onError })`;`off`/其它→`undefined`。收敛"mode→启用态实例"映射,杜绝 cli 散落 `enabled:true`。从 `index.ts` 导出。
- [x] 2.2 `packages/client/src/cli.ts`:读 `CHAT_A_SELF_CONSISTENCY`(缺省 `off`),经 helper 创建 Guard(`onDecision` 适配进既有 `trace.sink`,有 sink 才记;`onError` 友好告警)。`makeConvo` 在提供时注入 `selfConsistencyGuard`。
- [x] 2.3 `cli.ts`:状态行追加"自我一致性=off|on|llm"(仅偏离默认时点亮,避免刷屏)。

## 3. 巩固 daily / 每 N 轮触发驱动(client)

- [x] 3.1 `packages/client/src/assembly/consolidation.ts`:`ConsolidationHandle` 新增 `maybeConsolidateByCadence(unit, state)`——据 `consolidator.shouldRun('every-n-turns'/'daily', state)` 任一命中即后台 fire-and-forget `run`(失败仅告警,沿用既有降级路径);返回 `Promise<boolean>`(是否触发)供测试断言。`now` / `buildInput` 注入沿用既有。
- [x] 3.2 `packages/client/src/cli.ts`:进程内维护 `turnsSinceLast`(每 `chat` 回合后 +1)+ `lastConsolidatedAtMs`;每回合后(`convo.send` 之后,非首字热路径)若 `consolidation` 存在 → 组 `state={ turnsSinceLast, lastConsolidatedAtMs }`,调 `maybeConsolidateByCadence(unit, state)`;触发成功(返回 true)→ 重置 `turnsSinceLast=0`、`lastConsolidatedAtMs=now`,`batchIndex+1`。unit 用 `turns:<sessionId>:<batchIndex>` / `daily:<YYYY-MM-DD>`。
- [x] 3.3 `cli.ts`:`/reset` / 退出收尾的既有 `session-end` 触发**不变**;`CHAT_A_CONSOLIDATION` off(consolidation=undefined)时不计数、不调 `maybeConsolidateByCadence`(可选链),零行为变更。

## 4. 测试(全部不触网、注入端口)

- [x] 4.1 `packages/runtime/test/self-consistency-wiring.test.ts`(新增):注入假 Guard + `FakeLlm`——
  - drift=true → 下一轮 `PromptContext.anchor.drift===true`、system 含重锚段(经 spy assembler 或断言 system 文本)。
  - drift=false → 下轮 anchor 不填、无重锚段。
  - **不注入 Guard(默认)→ 回合正常、无重锚段(回归绿)**。
  - 假 Guard `check` 抛错 → 回合不崩、回复正常落库。
- [x] 4.2 `packages/persona/test`(扩充或新增):`createSelfConsistencyGuard('on')`→Default 启用态、`'llm'`→Llm 实例、`'off'`/缺省→undefined。
- [x] 4.3 `packages/client/test/assembly-consolidation.test.ts`(扩充):假 store + 注入 `now` + 注入 `state`——
  - `turnsSinceLast>=everyNTurns` → 触发;未达 → 不触发。
  - `daily`:距上次 ≥1 天 / 从未 → 触发;<1 天 → 不触发。
  - 同 unit 二次幂等跳过。
  - **off(未设)→ undefined(回归绿)**。

## 5. 验证与收尾

- [x] 5.1 `pnpm -r typecheck` 全绿。
- [x] 5.2 `npx vitest run` 全绿(新增 + 默认关回归);强调两处 off 缺省回归绿。
- [x] 5.3 `npx openspec validate companion-coherence-wiring --strict` 通过。
- [x] 5.4 `git commit`(中文)到当前 worktree 分支;不 push、不动 master。
