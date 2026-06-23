## 1. LlmSelfNotionEvolver(persona)

- [x] 1.1 `persona/src/llm-self-notion-evolver.ts`:`LlmSelfNotionEvolver implements SelfNotionEvolver`,仿 `llm-ocean-evolver.ts`——编号当前立场 position + 用户输入 → LLM 返回"被强化编号 + 小增量"JSON;tolerantJsonParse + 校验(下标合法/delta 有限正) → `SelfNotionStrengthDelta[]`(topicKey 用 topicKeyOf(notion));失败/乱码/null → 返回 null
- [x] 1.2 `persona/src/index.ts` 导出

## 2. Conversation 接线(runtime)

- [x] 2.1 `conversation.ts`:`ConversationDeps` 增 `selfNotionEvolver?: SelfNotionEvolver`
- [x] 2.2 `TurnContext` 增 `turn: number`;`TurnDeps` 把 `selfNotions: readonly SelfNotion[]` 换成 `selfNotionsManager: SelfNotionsManager`
- [x] 2.3 构造期:`const selfNotionsManager = new SelfNotionsManager({ seedNotions: seed.selfNotions ?? [], store: createKvSelfNotionStore(memory), ...(deps.selfNotionEvolver ? { evolver: deps.selfNotionEvolver } : {}) })`;放进 TurnDeps
- [x] 2.4 `send()`:调 strategy.run 时传 `turn: this.#turnSeq`(填 TurnContext.turn)

## 3. 共享回合逻辑(turn-shared)

- [x] 3.1 `detectStance`:`deps.selfNotionsManager.current()` 取代 `deps.selfNotions`
- [x] 3.2 `finalizeTurn`:在 `persona.advance` 之后 `await deps.selfNotionsManager.advance(args.userText, args.turn)`(args 增 turn);自带容错(manager.advance 不抛)
- [x] 3.3 两策略(SingleShot/ToolCalling):收尾调 finalizeTurn 时传 `turn: ctx.turn`

## 4. cli 接通

- [x] 4.1 `client/cli.ts`:`CHAT_A_SELF_NOTIONS_EVOLVE=llm` → `new LlmSelfNotionEvolver({ provider: llm })`;传 `selfNotionEvolver`
- [x] 4.2 横幅:立场演化状态(llm/off)

## 5. 测试

- [x] 5.1 默认等价:无 evolver → Conversation 回合 stance 命中与接线前一致;现有 runtime 全量回归(对外等价)绿
- [x] 5.2 注入 spy evolver:回合收尾 manager.advance 被调;被强化立场的 effectiveStrength 上升;持久化(同一 KvLike + 新 manager 实例)能读回演化后立场
- [x] 5.3 `LlmSelfNotionEvolver`:FakeLlm 返回合规 JSON → 对应 topicKey 增量;乱码/失败 → null(降级)
- [x] 5.4 演化后立场影响 stance:强度变化在 DefaultStanceDetector 低强度门控下可观测(可选)

## 6. 收尾

- [x] 6.1 `start.bat`/说明:`CHAT_A_SELF_NOTIONS_EVOLVE` 用法
- [x] 6.2 全量 `pnpm -r typecheck` + `npx vitest run` 通过;冒烟:开演化 + FakeLLM(或真模型)→ 横幅显示、回合不报错
