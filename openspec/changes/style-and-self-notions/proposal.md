## Why

canonical §7#4「真实对话纪律」要求小雪像真人一样说话——话短、口语、可以有口头禅、会"嗯嗯"接话——而**不要**"作为AI…"、不要过度解释、不要像写文章。当前这条纪律只散落在人格骨架的一句话里(`identity` 文本),**没有每轮主动 steer 的活机制**:骨架靠前(低注意力档),长对话里很容易被"助手腔"淹没。

同时 §7#3「会反对」的引擎(`DefaultStanceDetector` + `DissentContributor`)早已接好线,但默认种子 `XIAOXUE_SEED` 的 `selfNotions` **是空的** → stance 引擎空转,小雪没有任何具体观点可命中,"会反对"有形无实。

本切片(纯文字、纯 prompt)补齐这两点:① 把对话风格纪律提升为**每轮注入的 contributor**(放靠近末尾的高注意力档,可由 `expressiveness` 旋钮微调强度);② 给小雪填几条真实观点立场,让"会反对"真有内容可命中。

## What Changes

- **新增 `StyleDisciplineContributor`**(`@chat-a/cognition` `prompt/contributors.ts`):每轮注入一段对话生成纪律——话短、口语化、可有口头禅、会用"嗯""嗯嗯"接话;**禁**"作为AI…"、**禁**过度解释、别像写文章。挂到 `PROMPT_PRIORITY` 新增的 `style` 槽(放在 tone/dissent 附近的高注意力区,带注释)。
- **`expressiveness` 旋钮微调风格强度**:外置分档(含蓄 / 中性 / 外放),无 magic number——含蓄档更克制(更短、更收敛口头禅),外放档允许更多语气词/口头禅。强度来自 `PromptContext.expressiveness`(可选;缺省走中性档,守接缝边界不破降级)。
- **`PromptContext` 增加可选 `expressiveness` 字段**(由回合编排层据人格旋钮填入;缺省时 contributor 回落中性档)。
- **做实 `XIAOXUE_SEED.selfNotions`**:填 3-4 条真实观点立场(`{ topic, position }`),让 `DefaultStanceDetector` 真有内容可命中,"会反对"有依据。
- **`persona.example.yaml`** 的 `selfNotions` 示例区对齐补充,与种子风格一致。
- runtime `Conversation` 仅在 assembler 注册列表加一行注册 `StyleDisciplineContributor`(+ 必要 import),不动其它逻辑。

Non-goals(本切片不做):

- 不重写人格骨架 `identity`(骨架仍保留风格摘要;本切片补"每轮主动 steer")。
- 不接入语音侧 prosody / 不做 TTS 风格控制(§7#5,语音轨)。
- 不把 `expressiveness` 端到端从 Conversation `#composeSystem` 注入(本切片限制 conversation.ts 仅加注册行;运行时回落中性档,旋钮机制由 contributor + golden 验证)。

## Capabilities

### Modified Capabilities
- `prompt-assembly`: 新增 `StyleDisciplineContributor` 与 `PROMPT_PRIORITY.style` 槽;`PromptContext` 字段集增加可选 `expressiveness`,供风格纪律分档,字段仍 MUST 仅来自当轮已有数据、由编排层填入(接缝边界不变)。
- `stance-disagreement`: 默认人格种子(小雪)MUST 自带非空 `selfNotions`,使确定性 stance 检测有可命中的真实观点,"会反对"落到具体话题。

## Impact

- **延迟预算(§3.2)**:`StyleDisciplineContributor` 同步、无 I/O,纯字符串拼接,首字零额外延迟(承 PromptContributor 接缝契约)。
- 代码:
  - `@chat-a/cognition`:`prompt/types.ts` 增 `PromptContext.expressiveness?`;`prompt/config.ts` 增 `PROMPT_PRIORITY.style` + `STYLE_EXPRESSIVENESS` 分档常量;`prompt/contributors.ts` 增 `StyleDisciplineContributor`;`prompt/index.ts` 经 `export *` 自动导出。
  - `@chat-a/persona`:`seed.ts` 的 `XIAOXUE_SEED.selfNotions` 填真实观点。
  - `@chat-a/runtime` `Conversation`:assembler 注册列表加一行 `StyleDisciplineContributor`(+ import)。
  - `persona.example.yaml`:`selfNotions` 示例对齐。
- 数据:无 schema 变更;`selfNotions` 经现有 `seedPersonaMemories`/`addMemory` 路径(subject=agent),沿用既有去重。
- 已锁决策不受影响:确定性内核优先、行为即配置(分档外置)、接缝边界、延迟预算均遵循。
