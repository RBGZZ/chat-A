## Why

当前 `packages/runtime/src/conversation.ts` 的 `Conversation.send()` 把"**一个回合具体怎么跑**"焊死在方法体里:读心情(`persona.tone`)→ 分歧检测(`stanceDetector`)→ 组装 prompt(`assembler`)→ 流式 LLM → 落记忆/情绪推进/决策 trace。这是一个单趟(single-shot)流程,没有扩展点。canonical §9 P3 要做 **Agent loop**(模型 tool-use 多步:调用工具 → 观察结果 → 再生成,直到收敛),它本质是"回合执行策略"的另一种实现;若继续把流程焊死在 `send()`,P3 要么大改 `send()`(爆炸半径不可控、破坏对外契约风险高),要么旁路复制一份编排逻辑(总线/correlationId/span/trace 重复)。

按 §3.1 接缝原则,应先把"回合体如何执行"抽成一个**类型化接缝** `TurnStrategy`,把现有焊死流程**逐字不变**迁进默认实现 `SingleShotStrategy`;`Conversation` 退守为"生命周期 + 总线 + correlationId/OTel span + 依赖装配"的稳定外壳,把回合体委托给注入的策略。这样 P3 Agent loop 只是再实现一个 `TurnStrategy`、挂到同一外壳上,既复用全部编排接缝、又把爆炸半径限制在新策略内。本 change 是**对外等价重构**(接缝抽离),不改任何行为。

## What Changes

- 新增 `TurnStrategy` 接缝:`{ run(ctx: TurnContext): Promise<string> }`,描述"一个回合的执行策略";`TurnContext` 携带回合编排层已建好的上下文(turnId/correlationId/turnSpan/turnStartMs/userText/onToken)与回合所需依赖句柄(经类型化接缝,不暴露 `Conversation` 内部)。
- 把现有 `send()` 的回合体(读心情 → 分歧检测 → 组装 prompt → llm span + 流式 → 落历史 → 情绪推进 → 写记忆 → 决策 trace 收尾)**逐字搬进**默认实现 `SingleShotStrategy.run()`,行为、emit 的事件、span 树、trace 字段全部不变。
- `Conversation` 保留:生命周期、总线 `turn:start`/`turn:end`、`correlationId`/OTel `turn` span、依赖装配;把回合体委托给注入的 `TurnStrategy`(默认 `SingleShotStrategy`)。
- `ConversationDeps` **新增可选** `strategy?: TurnStrategy`(缺省 `SingleShotStrategy`);其余构造参数、`send(userText, onToken)` 签名与行为**逐字不变**。
- 优雅降级与可追溯不变:LLM 抛错仍走 `turn:end{reason:'error'}` + span ERROR;trace/记忆/情绪推进的吞错降级原样保留(§3.2)。

## Capabilities

### New Capabilities
- `turn-strategy`: 回合执行的策略接缝——`TurnStrategy`/`TurnContext` 接口、默认 `SingleShotStrategy`(承载现有单趟流程,对外等价)、`Conversation` 经注入委托回合体且公开契约不变、自定义策略可替换回合执行(为 §9 P3 Agent loop 铺路)。

### Modified Capabilities
<!-- 无 spec 级行为变更:本 change 是新增接缝并保持对外等价,不修改 prompt-assembly/persona-emotion/persistent-memory/decision-trace 的既有需求。 -->

## Impact

- **`packages/runtime/src/conversation.ts`**(唯一落点):抽出 `TurnStrategy`/`TurnContext` 类型;新增 `SingleShotStrategy`(迁入现有回合体);`Conversation.send()` 退守为外壳 + 委托;`ConversationDeps` 加可选 `strategy?`。
- **`packages/runtime/src/index.ts`**:导出新增类型/类(随 `export * from './conversation'` 自然带出)。
- **契约测试**(`packages/runtime/test`):`SingleShotStrategy` 契约测试(等价基线)+ "注入自定义 `TurnStrategy` 可替换回合执行"接缝测试;**现有 runtime 测试零改动全过**(对外等价验收门)。
- 影响 canonical 章节:**§9 P3**(Agent loop 前置接缝);承 §3.1(接缝化)、§3.2(优雅降级 / 延迟预算不变)、可追溯(§8.1 trace/span 不变)。
- **延迟**:仅多一层方法委托,无新增 I/O / await,首字延迟不变(§3.2)。
- **非破坏**:`Conversation` 公开 API(`ConversationDeps`/`send` 签名/事件/trace 字段)逐字不变,`packages/client/src/cli.ts` 与所有现有测试**零改动仍通过**。不触碰其它包、不动持久化 schema。

### Non-goals
- 实现 Agent loop / tool-use 多步策略本身(§9 P3 后续 change,挂到本接缝上)。
- 打断(barge-in)、多策略动态选择、策略级配置外置(后续)。
- 改动回合内任何行为(prompt 组装、情绪、记忆、分歧、trace 的逻辑均原样保留)。
