## Why

canonical §0 七维之**一致性**判据是"**联想式记忆 + 自我连贯(不自相矛盾)**"——长期陪伴最致命的失败就是"突然否定自己确立过的核心自我"(忘了自己叫什么、推翻根本信念/根本人设)。§6.1 明列**自我一致性锚定**(LingYa `guard.py` re-anchor 扩展):回合回复与"语义召回的自我记忆"比对,漂移则**温和重锚**。

当前小雪已有 §5.3 `subject=agent` 自我记忆(种子 lore + self_notions + 涌现自我事实,可经 recall 召回)、§7#3 会反对的 stance 机制、§5.4 PromptAssembler 优先级注入接缝;但回合生成里**没有任何"回复是否与确立过的核心自我矛盾"的检测/重锚机制**。

关键张力(§6.1 原话):**阈值放宽以允许有个性的偏离**——"我不同意你""我改主意了""我有个新喜好"都是"有自我"的体现(§7#3 会反对),**绝不能被当成漂移拉回**;只有**否定核心设定**(名字 / 根本信念 / 根本人设)才算漂移。本切片把这条"自我连贯"主线落地为**可选、可配、缺省安全**的最小可用形态。

## What Changes

- **新增自我一致性检测接缝 `SelfConsistencyGuard`**(异步,沿用 `Appraiser`/`StanceDetector`/`SelfNotionEvolver` 接缝风格):据本轮回复(候选)+ **语义召回的核心自我记忆**(subject=agent 的 core_belief/self_notion/self_lore)判定回复是否与**确立过的核心自我矛盾**(漂移)。
  - **确定性默认实现 `DefaultSelfConsistencyGuard`(可选、保守)**:**只**对"核心锚点"(name / 显式标注的核心断言)做**显式否定线索**命中(如"我不叫X""我不是X""我没有Y信念"这类否定模式)——一个 golden 可测的窄规则。**它绝不把观点偏离/"我不同意"/新喜好判为漂移**(那些根本不命中否定核心锚点的模式)。语义级矛盾判定**不假装能算**(§3.2 能用代码算的才算)。
  - **LLM 实现 `LlmSelfConsistencyGuard`(opt-in,默认关)**:给定回复 + 核心自我记忆,走 **schema 约束**输出 `{"drift": boolean, "reason": string}`;任何失败(异常/乱码/越界)→ 降级为**不锚定**(判为不漂移),绝不阻塞、不崩(§3.2)。其 prompt 明确要求"只把否定核心设定算漂移,观点变化/不同意/新想法不算"。
- **新增重锚(re-anchor)**:仅当判定为**与核心自我矛盾**时,产出一条 `AnchorResult { drift, reason?, hint? }`;新增 `ReAnchorContributor`(cognition)挂到 §5.4 预留优先级槽,把"请以你确立过的自我为准、温和重述/修正,不必否定核心设定"作为下轮高注意力 steer 注入——**不是把所有偏离都拉回**,只在漂移时温和提醒。
- **行为即配置**:`SelfConsistencyConfig`(启用开关 `enabled` **默认 false**;`strictness` 档;否定线索词表外置)——**缺省安全**(默认关 = 行为完全不变)。prompt 重锚片段外置可调(§3.2 #4 / §6.2)。
- **可追溯(§8.1)**:Guard 暴露可选 `onDecision` sink,落"是否漂移 / 理由 / 命中锚点"决策 trace(经现有 trace 接缝;persona 侧只留 sink 接缝,不强依赖 observability 包)。
- **放宽阈值落地**:漂移 = 仅"否定核心设定"(name / 核心信念 / 根本人设)。**不算漂移**:观点变化、"我不同意用户"、有新喜好/兴趣、措辞情绪波动。确定性侧靠"只匹配核心锚点的否定模式";LLM 侧靠 prompt 显式约束 + 失败降级不锚定。

Non-goals(本切片不做):

- **autonomy 主动 / open threads / prosody / 负面 IPC 姿态**(其余 §7,各自切片)。
- **改写已生成回复**(generate→改写 pass 属强制反谄媚族,§7#3 已记录暂缓)——本期只"注入下轮重锚 steer",不二次生成、不截流。
- **memory 包内部改动**:不新增 recall API、不动 schema;核心自我记忆由**编排层**用既有 recall 召回后传入 Guard(persona 侧定义最小注入端口)。
- **embedding 相似度内核**:确定性侧不引向量计算(persona 不依赖 embedder 运行时);"语义召回"由编排层在 persona 之外完成,Guard 只消费召回结果。

## Capabilities

### New Capabilities
- `self-consistency-anchor`: 小雪的回复与"确立过的核心自我"保持连贯、不自相矛盾的能力——含 `SelfConsistencyGuard` 接缝(确定性默认保守 + LLM 可选)、核心自我记忆注入端口、漂移→`ReAnchorContributor` 温和重锚、`enabled`/`strictness` 配置门控(缺省关)、放宽阈值(观点偏离/不同意/新想法不算漂移)、决策 trace sink。

### Modified Capabilities
- `prompt-assembly`: `PromptContext` 字段集增加 `anchor`(本轮自我一致性判定结果),供 `ReAnchorContributor` 消费;字段仍 MUST 仅来自当轮已有数据、由编排层填入(接缝边界不变)。

## Impact

- **延迟预算(§3.2)**:确定性 Guard 是回合内同步字符串匹配,**首字零额外延迟**;LLM Guard 默认关,开启时**在回复生成之后**(对回复候选判定)运行,与 appraiser 同档(回合后/可降级),不挡流式首字。
- 代码(主战场 persona,必要时 cognition):
  - `@chat-a/persona`:`types.ts` 增 `SelfConsistencyContext`/`AnchorResult`/`SelfConsistencyGuard`/`SelfMemoryRef`/`SelfConsistencyConfig` 接缝;新增 `self-consistency.ts`(`DefaultSelfConsistencyGuard` 确定性 + 否定线索词表外置)+ `llm-self-consistency.ts`(`LlmSelfConsistencyGuard` opt-in,schema 约束 + 降级);`defaults.ts` 增配置常量;`index.ts` 导出。
  - `@chat-a/cognition`:`prompt/types.ts` 增 `PromptContext.anchor`(轻量结构,不强耦合 persona);`prompt/config.ts` 增 `PROMPT_PRIORITY.reAnchor` 槽;`prompt/contributors.ts` 增 `ReAnchorContributor`;`prompt/index.ts` 导出。
- 数据:无 schema 变更;核心自我记忆经既有 `recall`(subject=agent)召回,只读。
- 默认行为:**`enabled` 缺省 false → 既有 persona/cognition 行为字面不变**,既有测试全绿(硬约束)。
