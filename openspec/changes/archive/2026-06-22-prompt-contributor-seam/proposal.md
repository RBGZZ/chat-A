## Why

当前本轮 system prompt 由 `Conversation.#composeSystem` **硬编码三段拼接**(persona 骨架 + `[与当前输入相关的记忆]` 召回块 + tone fragment),没有扩展点、没有优先级、没有 context 预算管理。canonical §5.4 把"prompt 组装"定为一个**优先级 Injection 接缝**,而 §7 后续所有行为项(自传记忆、未了话题/open threads、affectGuidance、stance 异议)都要往 prompt 注入内容;若继续硬编码,每加一项都要改 `#composeSystem` 的拼接逻辑,爆炸半径不可控,且无法落地 §5.4 的两档注入与 KV-cache 稳定性规则。先把这个**共同地基**接缝化,后续行为层才能各自挂载、互不干扰。

## What Changes

- 新增 `PromptContributor` 接缝:`{ contribute(ctx): PromptFragment | null; cleanup?(): void }`,各注入来源(人格/记忆/tone,后续情绪/未了话题/异议)各做成一个 contributor,返回 `{ text, priority }`。
- 把现有三段拼接重构成三个**内置 contributor**:PersonaSkeleton(人格骨架)、MemoryRecall(记忆 RAG 召回)、Tone(本轮情绪 tone fragment)。
- 新增 `PromptAssembler`:收集各 contributor 的非空 fragment,**按 priority 升序拼接**(高优先级靠近末尾 = 最近注意力),拼到 context 预算上限时**从最旧历史裁剪**,拼完逐个 `cleanup()`(§5.4)。
- 落地 **两档注入**(§5.4):核心档(pinned 永驻:用户名/过敏、Agent 名/core_belief 等根本设定)每轮必注入;外围档(语义召回)按相关性召回。两档以 fragment 区分,核心档不参与裁剪。
- 落地 **KV-cache 稳定性规则**(§5.4):系统提示 + 人格前缀**字节级稳定**供 KV 复用;volatile 上下文(时间戳/id)以扁平 `[Context]` bullet **追加到最后一条用户消息**,**不**用 `<context>` XML 标签(弱模型会回吐)。
- `Conversation.#composeSystem` 改为**委托** `PromptAssembler`,对外输出等价(契约测试保证:相同输入下新旧组装结构等价)。
- 优雅降级(§3.2):某 contributor 抛错则**跳过该段**、不崩回合。

## Capabilities

### New Capabilities
- `prompt-assembly`: prompt 组装的优先级 Injection 接缝——`PromptContributor`/`PromptFragment` 接口、`PromptAssembler`(优先级升序拼接 + context 预算裁剪 + cleanup)、三个内置 contributor、两档注入与 KV-cache 稳定性规则、单 contributor 故障降级。

### Modified Capabilities
<!-- 无 spec 级行为变更:本 change 是新增接缝并保持对外等价输出,不修改 persona-emotion/persistent-memory/llm-cognition 的既有需求。 -->

## Impact

- **`packages/cognition`**(新增,主落点):新增 `PromptContributor`/`PromptFragment`/`PromptContext` 类型、`PromptAssembler`、三个内置 contributor;`buildSystemPrompt` 所在包,人格骨架 contributor 复用之。
- **`packages/runtime/src/conversation.ts`**:`#composeSystem` 调用点替换为 `PromptAssembler`;`messages` 仍为 `snapshot()+userMsg`,volatile context 追加到末条用户消息(由 assembler 输出)。
- **契约测试**:等价性(新旧 system 结构等价)、优先级升序排序、预算裁剪(从最旧 history 裁)、单 contributor 抛错降级。
- 影响 canonical 章节:**§5.4**(两档注入 + 优先级 Injection 接缝 + KV-cache);承 §3.1(接缝化)、§3.2(优雅降级 / 延迟预算)、行为即配置(prompt 版本化可热调)。
- **延迟**:仅本地字符串拼接 + 字符/近似 token 计数,无新增 I/O,可忽略(§3.2);KV-cache 稳定前缀反而利于延迟。
- **非破坏**:纯结构接缝化,对外输出等价;不触碰 SQLite 真相源 schema、不改记忆/人格写路径。

### Non-goals
- 真 embedding / 语义召回(P2,§5.5):本 change 沿用现有关键词 `recall`,只是把它包成 contributor。
- 具体行为 contributor:stance 异议、自传记忆、open threads、affectGuidance 等(各自后续 change,挂到本接缝上)。
- KV-cache 之外的延迟优化(超出本 change 范围)。
