# 设计:companion-coherence-wiring

承本 change proposal。这里只记**装配/接线层的关键决策**;Guard / Contributor / Consolidator / `shouldConsolidate` 的内核设计见各自已归档 change。

## 决策 1:Guard 注入沿用既有 opt-in 接缝注入模式(同 stanceDetector / oceanEvolver)

`Conversation` 已有一排"可选接缝注入"依赖(`appraiser` / `stanceDetector` / `oceanEvolver` / `selfNotionEvolver` / `embedder` …),全部"不注入=默认行为不变"。自我一致性 Guard **完全照此**:

- `ConversationDeps` / `TurnDeps` 新增可选 `selfConsistencyGuard?: SelfConsistencyGuard`(来自 `@chat-a/persona`,既有导出)。
- 缺省不注入 → `TurnDeps.selfConsistencyGuard` 为 `undefined` → 回合体不调用 Guard、不召回自我记忆、anchor 恒空。**零行为变更。**
- cli 按 `CHAT_A_SELF_CONSISTENCY=off|on|llm` 创建实例(off→不创建):
  - `on` → `new DefaultSelfConsistencyGuard({ config: { enabled: true, strictness: 'core-only' }, onDecision })`
  - `llm` → `new LlmSelfConsistencyGuard({ provider: llm, config: { enabled: true, strictness: 'core-only' }, onDecision, onError })`
  - `onDecision` 适配进既有 `trace.sink`(有 sink 才记;沿用 cli 既有 `createDecisionTraceSinkFromEnv` 句柄)。
- **构造 helper**:为免 cli 直接写 `enabled:true` 配置字面量,在 persona 加一个纯加法 helper `createSelfConsistencyGuard(mode, opts)`(可选;若 cli 直接 new 也可,helper 仅收敛"mode→实例 + enabled:true"映射,无 magic number 散落)。

> 注意 Guard 的 `enabled` 缺省 false(`DEFAULT_SELF_CONSISTENCY_CONFIG`)。cli `on`/`llm` 时必须显式传 `config.enabled=true`,否则 Guard 内核会对一切输入返回 `{drift:false}`(等价没接)。这是 helper 要收敛的关键点。

## 决策 2:Guard 在回复生成后跑,drift 影响**下一轮**(跨回合状态,放 Conversation 外壳)

设计已定(`ReAnchorContributor` 注释 + `self-consistency-anchor` spec):**本期只注入下轮 steer,不改写已生成回复**。故:

- Guard 调用点放在 `turn-shared.ts` 的 `finalizeTurn`(回复已生成、首字之后,与情绪推进/写记忆同段;§3.2 不挡流式)。
- drift 结果不能塞进**本轮**已组好的 prompt(已发给 LLM),只能存起来供**下一轮** `composeSystem` 时填 `PromptContext.anchor`。
- 跨回合的 anchor 状态归 `Conversation` 外壳(`#pendingAnchor?: AnchorInput`):
  - `finalizeTurn` 算出 `AnchorInput`(drift 时 `{drift:true, anchorText}`;否则不漂移)→ 经回调写回外壳的 `#pendingAnchor`。
  - 下一轮 `SingleShotStrategy.run` 把 `ctx.deps` 携带的 `pendingAnchor` 透传给 `composeSystem` → 填 `PromptContext.anchor` → `ReAnchorContributor` 注入重锚 → 用过即清(单轮一次性,重锚不应粘连多轮)。
- **接线手法**:`TurnContext` 加只读 `pendingAnchor?: AnchorInput`(外壳每轮填入当前待重锚);`finalizeTurn` 的 args 加可选回调 `setPendingAnchor?(a: AnchorInput | undefined)` 由外壳注入,把本轮 Guard 结论写回外壳。两者都"不传=现状",对默认路径零影响。

> 备选(否决):把 drift 存进 memory KV。否决理由——重锚是**纯瞬态的下轮 steer**,不该持久化污染记忆;且会引入 memory 写依赖,违背"只调既有 API、不加跨包耦合"。进程内 `#pendingAnchor` 最简、最贴合语义。

## 决策 3:自我记忆召回复用既有 `memory.recall`,在编排层过滤 `subject==='agent'`

persona 的 `SelfConsistencyContext` 要 `SelfMemoryRef[]`(`{text, kind?, core?}`)+ `agentName`。编排层(`finalizeTurn`)负责取数(接缝边界 §3.1,persona 不碰 memory 包):

- 用既有 `deps.memory.recall(userText)`(或对 agent 自我用一个稳定 query;MVP 直接复用本轮 `recall` 已召回的 `recalled`,从中筛 `subject==='agent'`,**零额外召回开销**)。
- 映射:`SelfMemoryRef = { text: r.text, kind: r.kind, core: r.memoryKind === 'core' || r.pinned === true }`。
- `agentName` = `deps` 携带的人格 name(`Conversation` 构造期从 seed 取,放进 `TurnDeps`)。
- 召回为空 / 无 agentName → Guard 内核自降级为 `{drift:false}`(已实现),不需编排层特判。

> 复用本轮 `recalled` 即可:它已是本轮召回结果,其中 subject=agent 的核心 lore/notion 正是要锚的核心自我。无需为锚定再发一次召回(非阻塞 §5.5、零额外延迟)。若本轮 recalled 中无 agent 记忆,则该轮无可锚点——可接受(MVP;后续可加专门的 self 召回,留接缝)。

## 决策 4:巩固 daily / 每 N 轮触发由 cli 回合循环驱动(计数 + 上次时刻),沿用既有 handle

`Consolidator` 已有 `shouldRun(trigger, state)`(实例封装纯函数 `shouldConsolidate`,用本编排器配置 + 时钟)。缺的只是**驱动状态**:

- `assembleConsolidation` 的 `ConsolidationHandle` 新增 `maybeConsolidateByCadence(unit, state)`:据 `shouldRun('every-n-turns', state)` / `shouldRun('daily', state)` 判定,任一命中 → 后台 fire-and-forget `run`(失败仅告警,同既有 `consolidateSession`)。`state` 由 cli 提供 `{ turnsSinceLast, lastConsolidatedAtMs }`。
- cli 在每个 `chat` 回合后(`convo.send` 之后,非首字热路径)累加 `turnsSinceLast`,调 `maybeConsolidateByCadence`;**触发成功后重置计数 + 记录 `lastConsolidatedAtMs=now`**(下个窗口重新累计,幂等键 unit 用 `turns:<sessionId>:<batchIndex>` / `daily:<YYYY-MM-DD>`,Consolidator 内部 state key 兜底防重)。
- 上次巩固时刻 / 轮数计数是 cli 进程内状态(MVP);跨重启持久留接缝(可复用 memory KV,本 change 不做——重启即新 session,session-end 会兜底巩固)。
- **节奏阈值**:`everyNTurns` / `dailyIntervalDays` 走 `ConsolidationConfig`(既有,默认 50 / 1 天);cli 可经 `Consolidator` 配置覆盖(行为即配置,不写 magic number)。
- `CHAT_A_CONSOLIDATION` 缺省 off → `assembleConsolidation` 返回 `undefined` → cli 不计数、不调 `maybeConsolidateByCadence`(可选链),**零行为变更**;session-end 既有触发不变。

> 单元(unit)幂等:每 N 轮用递增 `batchIndex`(每触发一次 +1),daily 用日期串。两者天然不重复;Consolidator 内部 `kv_state` 存在性检查再兜一层(同 reflector 模式)。

## 测试策略(全部不触网、注入端口)

- **runtime / Guard 接通**(`packages/runtime/test`):注入一个假 Guard(记录 check 入参、可控返回 drift),`FakeLlm` 跑回合:
  - 假 Guard 返回 `drift:true` → 下一轮 `composeSystem` 的 `PromptContext.anchor.drift===true`、`ReAnchorContributor` 注入重锚段(断言 system 含重锚语义 / assembler 收到 anchor)。
  - 返回 `drift:false` → 下轮 anchor 不填、无重锚段。
  - **不注入 Guard(默认)→ 回合正常、system 无重锚段(回归绿)**。
- **persona helper**(若加):`createSelfConsistencyGuard('on')` 产出 `enabled:true` 的 Default 实例、`'llm'` 产出 Llm 实例、`'off'`/缺省产出 undefined。
- **client / 巩固节奏触发**(`packages/client/test/assembly-consolidation.test.ts` 扩充):假 store + 注入 `now` + 注入 `state`:
  - `turnsSinceLast >= everyNTurns` → `maybeConsolidateByCadence` 触发 run;未达 → 不触发。
  - `daily`:`lastConsolidatedAtMs` 距 now ≥ 1 天 → 触发;< 1 天 → 不触发;`undefined`(从未)→ 触发。
  - 同 unit 二次触发幂等跳过(写了 state key)。
  - **off(未设 `CHAT_A_CONSOLIDATION`)→ undefined,cli 不计数(回归绿)**。

## 接缝边界复核(§3.1)

- persona 不依赖 memory 包:Guard 只吃 `SelfMemoryRef[]`,编排层做 memory→ref 映射。✔(既有设计)
- cognition 不碰 MemoryStore / Persona:`ReAnchorContributor` 只读 `ctx.anchor`,编排层填。✔
- 巩固薄壳只经 `Consolidator` 类型化接缝,不 import memory 内部。✔(沿用既有 `assembly/consolidation.ts`)
- 不碰 voice-loop 内部;只在 conversation/turn-shared/cli/assembly 接。✔
