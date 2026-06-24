## Why

两处"已实现但未接进回合流程"的编排接缝,使能力空有积木却不在跑——夯实可用性的最后一公里:

- **自我一致性锚定(§6.1)**:`DefaultSelfConsistencyGuard` / `LlmSelfConsistencyGuard`(persona)、`ReAnchorContributor`(cognition)、`PromptContext.anchor` / `AnchorInput` 都**已实现完整**(`self-consistency-anchor` 已归档为能力),但**回合流程从不创建、不调用 Guard**——`packages/runtime/{conversation.ts,turn-shared.ts}` 没有 Guard 调用点,`ReAnchorContributor` 没注册进 assembler,`packages/client/src/cli.ts` 没装配 Guard。结果:回复就算否定核心自我也不会被检测、下轮不会温和重锚。
- **夜间巩固 daily / 每 N 轮触发(§5.1)**:`Consolidator.run`(双 Pass 调和 + 惊奇门控)+ 纯函数 `shouldConsolidate('session-end'/'daily'/'every-n-turns', …)` **已实现**,cli 也已在**会话结束 / `/reset`** 触发 `session-end`。但 `daily` / `every-n-turns` 两类触发**没有驱动**——没人累计轮数、没人记录上次巩固日期,长会话里巩固永远等不到下一次会话结束才跑。

本 change 是**纯装配/接线层**:在回合编排层(`runtime`)与 cli 装配收敛点(`client`)把这两处接通。**不重写任何模块内部**,只调既有公开 API。

**硬线(回归绿是底线)**:两处接线**默认安全、缺省关 / 缺省=现状**;**关闭时既有回合行为逐字不变**——既有全量测试全绿不可破。真硬件 / 真模型 / 真网络**不在本 change 验证**,用 Fake/Stub + 注入端口(假 store / 假 clock / 注入轮数)写不触网单测。

## What Changes

- **自我一致性 Guard 接进回合流程**(默认关):
  - cli 按新开关 `CHAT_A_SELF_CONSISTENCY=off|on|llm`(缺省 `off`)创建并注入 Guard 实例(`on`=确定性 `DefaultSelfConsistencyGuard`;`llm`=`LlmSelfConsistencyGuard`),`onDecision` 落既有决策 trace sink(有 sink 才记)。
  - `Conversation` 构造期把 `ReAnchorContributor` 注册进 `PromptAssembler`(无 anchor 时它返回 `null`,**对默认路径零注入、行为字面不变**)。
  - 回合体在**回复生成后**:若注入了 Guard → 用既有 `memory.recall` 召回 `subject==='agent'` 的核心自我记忆,以 `SelfMemoryRef[]` + `agentName` 喂 `guard.check(reply, …)`;`drift` 则把 `AnchorInput` 暂存,**填进下一轮** `PromptContext.anchor`(由 `ReAnchorContributor` 注入温和重锚)。Guard 失败/未注入 → 不锚定、回合继续(§3.2)。
  - 缺省 `off` 时:cli 不创建 Guard,`Conversation` 不调用 Guard、anchor 恒空、`ReAnchorContributor` 恒返回 `null` → 回合行为逐字不变。
- **夜间巩固 daily / 每 N 轮触发驱动**(沿用 `CHAT_A_CONSOLIDATION`,缺省 off):
  - cli 在回合循环累计"距上次巩固的轮数" + 记录"上次巩固日期/时刻",每个用户回合后按 `Consolidator.shouldRun('every-n-turns'/'daily', state)` 判定;阈值到达 → **后台 fire-and-forget** 调既有 `consolidateSession`(失败仅告警,不阻塞热路径)。
  - 触发节奏阈值(`everyNTurns` / `dailyIntervalDays`)走既有 `ConsolidationConfig`(行为即配置)。
  - 既有 `session-end`(退出收尾 / `/reset`)触发**不变**;`CHAT_A_CONSOLIDATION` 缺省 off 时不构造 Consolidator、不计数,行为逐字不变。

## Non-goals

- **不碰 `voice-loop.ts` 内部打断核心**:只在 `conversation.ts` / `turn-shared.ts` 回合编排层接、cli 装配层接。
- **不重写** persona / cognition / memory 各模块内部:Guard、Contributor、Consolidator、`shouldConsolidate` 全部已实现,只调既有公开 API。
- **不在热路径阻塞**:Guard 在回复生成后跑(首字之后,不挡流式),drift 只影响**下一轮** steer,不改写/不截断已生成回复;巩固触发后台 fire-and-forget。
- **不改既有 `session-end` 巩固语义**;不引入守护进程/cron(计时仍由回合循环驱动)。

## Impact

- **影响 canonical 章节**:§6.1(自我一致性锚定接进回合)、§5.1(巩固节奏 daily/每 N 轮驱动)、§8.1(锚定判定落决策 trace)、§3.1(只经类型化接缝接线、persona 不依赖 memory 包)、§3.2(默认安全 + 优雅降级 + 非阻塞)。与权威设计一致。
- **代码**:`packages/runtime/{conversation.ts,turn-shared.ts}`(Guard 调用点 + 注册 ReAnchorContributor + 下轮 anchor 透传)、`packages/client/src/{cli.ts,assembly/consolidation.ts}`(Guard 装配 + 巩固轮数/日期触发驱动)、必要时 `packages/persona`(Guard 构造 helper,纯加法)。memory / cognition **只调既有 API**;protocol 若需补类型**只追加不重排**(预期不需要)。
- **依赖**:复用各包既有导出;不引新依赖。
- **延迟预算**:Guard 在回复生成后(首字之后)跑,确定性实现为纯字符串扫描(微秒级),LLM 实现默认关;drift 只影响下轮 steer。巩固触发后台 fire-and-forget。**对用户首字延迟零影响**。
- **降级/默认**:`CHAT_A_SELF_CONSISTENCY` 缺省 `off`、`CHAT_A_CONSOLIDATION` 缺省 `off`;Guard 失败降级不锚定、巩固失败仅告警,均不拖垮回合(§3.2)。
- **测试**:新增接线/开关/降级单测(Fake/Stub + 注入端口,**不触网**):Guard 接通(drift→下轮 anchor 填充 / 不漂移→不填)、巩固按轮数/日期触发(幂等不重复)、**两处 off 缺省回归绿**;既有全量回归保持绿。
- **真机待验证(本 change 不验证)**:真 LLM Guard 的漂移判定质量、长会话里 daily/每 N 轮巩固的真实节奏与产出、真机免提连续对话下的锚定体验。

## Capabilities

### Modified Capabilities
- `self-consistency-anchor`: 新增"回合流程接通"要求——回合编排层在回复生成后调用注入的 Guard,drift 时把锚点透传到下轮 `PromptContext.anchor`;Guard 由 cli 按 `CHAT_A_SELF_CONSISTENCY=off|on|llm`(缺省 off)创建注入,`ReAnchorContributor` 注册进 assembler;缺省 off 时不创建不调用、行为逐字不变。
- `memory-consolidation`: 新增"daily / 每 N 轮触发驱动"要求——cli 回合循环累计轮数 + 记录上次巩固时刻,按 `shouldConsolidate('every-n-turns'/'daily')` 在阈值到达时后台 fire-and-forget 触发巩固;节奏阈值走 `ConsolidationConfig`;`CHAT_A_CONSOLIDATION` 缺省 off 时不计数不触发,既有 session-end 触发不变。
