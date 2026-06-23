## Context

§7#4 的对话纪律此前只在 `XIAOXUE_SEED.identity` 里有一句。骨架的 `priority=personaSkeleton(100)` 处于"靠前/低注意力"档,长对话里风格指令权重被稀释。§5.4 PromptAssembler 已是优先级 Injection 接缝:加一个 contributor、占一个高注意力 priority 槽即可,无需改装配/裁剪逻辑。

§7#3 的 stance 引擎(`DefaultStanceDetector` + `DissentContributor`)已就位,但只有"门控 + 命中"机制,没有可命中的内容——默认种子 `selfNotions` 为空。

## Goals / Non-Goals

- Goals:风格纪律每轮主动 steer(高注意力档);`expressiveness` 可微调强度(外置分档);小雪有真实观点可命中。
- Non-Goals:不重写骨架;不端到端从 Conversation 注入 expressiveness(本切片仅在 conversation.ts 加注册行);不碰 stance 检测算法本身。

## Decisions

### D1:风格纪律做成独立 contributor,占高注意力 priority 槽
- `StyleDisciplineContributor` 返回 `tier:'peripheral'`(允许预算裁剪——风格是 steer,不是核心事实),`priority=PROMPT_PRIORITY.style`。
- `style` 槽放在 tone(900) 与 dissent(950) 附近的高注意力区。取 **920**:在 tone 之后(风格指令比"当前情绪"更想贴近末尾),在 dissent(950) 之前(立场/反谄媚作为本轮最强 steer 仍压轴)。带间隙不挤占既有槽。
- 为什么不写进骨架:骨架靠前易被稀释;独立 contributor 可被 `expressiveness` 调制、可独立测试、可被预算裁剪(降级时优先保留事实/记忆)。

### D2:`expressiveness` 分档外置(行为即配置,无 magic number)
- 新增 `STYLE_EXPRESSIVENESS = { reservedCeil, expressiveFloor }`:`< reservedCeil` 含蓄档(更短、收敛口头禅)、`[reservedCeil, expressiveFloor)` 中性档、`>= expressiveFloor` 外放档(更多语气词/口头禅)。沿用 `DISSENT_ASSERTIVENESS` 的双阈值分档范式。
- 三档共享同一条"硬纪律"(禁"作为AI…"/禁过度解释/别像写文章/话短口语)——这是不可调的底线;只有"口头禅/语气词的放开程度"随 expressiveness 变化。这样旋钮调"风味"而非"是否守纪律"。

### D3:`expressiveness` 经 `PromptContext` 可选字段传入,缺省回落中性档
- `PromptContext.expressiveness?: number`([0,1])。contributor 用 `ctx.expressiveness ?? 中性档代表值`。
- 受切片约束(conversation.ts 仅允许加注册行),本期**不**在 `#composeSystem` 注入 expressiveness → 运行时回落中性档;旋钮分档机制由 golden 直接构造 ctx 验证。后续可在编排层一行接通(seed.dials.expressiveness)。

### D4:小雪的 selfNotions 内容
- 选与"长期陪伴/生活态度"贴合、topic 关键词在日常对话里可命中的观点(咖啡慢生活、熬夜、独处/社交、礼物心意)。每条 `topic` 给中英/同义关键词,`position` 用第一人称口语立场文本(直接可进 prompt 与记忆)。
- 与 `persona.example.yaml` 既有两条(咖啡、熬夜)风格对齐;example 补到与种子同等覆盖。

## Risks / Trade-offs

- 风格段被预算裁剪:tier=peripheral,极端预算下可能被裁——可接受(事实/记忆优先;且骨架仍有风格摘要兜底)。
- 运行时 expressiveness 暂未接通 → 实际只走中性档:符合切片边界,机制完整、可后续一行接通;golden 证明分档可观测。

## Migration Plan

无数据迁移。`selfNotions` 经现有 `seedPersonaMemories` 路径写入(幂等),旧会话不受影响。
