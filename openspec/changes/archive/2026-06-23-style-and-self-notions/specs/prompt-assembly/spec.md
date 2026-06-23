## ADDED Requirements

### Requirement: 对话风格纪律每轮注入

系统 SHALL 提供 `StyleDisciplineContributor`,每轮向 system 注入一段对话生成纪律(§7#4),内容 MUST 含一组不可调的硬纪律:话短、口语化自然、可以有口头禅、会用"嗯/嗯嗯"接话;**禁止**"作为AI…"之类自指、**禁止**过度解释、不要像写文章。该 contributor MUST 同步、MUST NOT 引入 I/O 或网络(承 PromptContributor 接缝契约 §5.4),并 SHALL 以 `tier='peripheral'` 注入(允许极端预算下被裁剪,核心事实优先)。其 `priority` SHALL 取 `PROMPT_PRIORITY.style`,位于 tone 之后、dissent 之前的高注意力区。

风格强度 SHALL 由 `expressiveness` 旋钮以**外置分档**微调(无 magic number),且仅调制"口头禅/语气词的放开程度",不削弱上述硬纪律。`expressiveness` 缺省时 MUST 回落中性档。

#### Scenario: 每轮注入风格硬纪律

- **WHEN** 组装本轮 prompt
- **THEN** system 含风格纪律段,包含"禁止自称AI/不过度解释/话短口语"等硬纪律措辞,且该段 `priority=PROMPT_PRIORITY.style`、`tier='peripheral'`

#### Scenario: expressiveness 分档微调可观测

- **WHEN** 以含蓄档(低 expressiveness)、中性档、外放档(高 expressiveness)分别构造上下文
- **THEN** 三档产出的风格段文本互不相同(口头禅/语气词放开程度可观测差异),但硬纪律在三档中均保留

#### Scenario: 缺省 expressiveness 回落中性档

- **WHEN** 上下文未提供 `expressiveness`
- **THEN** 风格段按中性档产出,不抛错(守降级边界)

## MODIFIED Requirements

### Requirement: PromptContext 据现有回合数据组装

`PromptAssembler.assemble` SHALL 接受由回合编排层填充的 `PromptContext`,字段 MUST 仅来自当轮已有数据:人格骨架 `skeleton`、记忆召回结果 `recalled`(`MemoryRecord[]`,可空)、tone fragment `toneFragment`、用户输入 `userText`、历史滑窗 `history`(`ChatMessage[]`),MAY 含本轮分歧检测结果 `stance`(由编排层调 `StanceDetector` 产出,缺省/无异议时省略)、`expressiveness` 旋钮值(由编排层据人格旋钮填入,缺省时风格纪律回落中性档)与 volatile 键值 `volatile`。assembler MUST NOT 自行访问 MemoryStore / Persona / StanceDetector 等具体实现(承 §3.1 接缝边界);取数、召回降级、stance 检测均由回合编排层负责。

#### Scenario: 由编排层注入上下文而非 assembler 自取

- **WHEN** 回合编排层调用 `assemble(ctx)`
- **THEN** assembler 仅消费 `ctx` 中字段产出结果,不直接调用 `memory.recall` / `stanceDetector.detect` 等具体实现

#### Scenario: 召回为空时上下文合法

- **WHEN** 记忆召回结果为空数组
- **THEN** `ctx.recalled` 为空,组装正常进行且不产出记忆注入段

#### Scenario: 无 stance 时上下文合法

- **WHEN** 本轮无分歧检测结果(`ctx.stance` 省略或为空)
- **THEN** 组装正常进行,DissentContributor 据 assertiveness 决定是否仍注入反谄媚基线,但不产出针对具体观点的异议段

#### Scenario: 无 expressiveness 时上下文合法

- **WHEN** 本轮未提供 `ctx.expressiveness`
- **THEN** 组装正常进行,StyleDisciplineContributor 按中性档注入风格纪律
