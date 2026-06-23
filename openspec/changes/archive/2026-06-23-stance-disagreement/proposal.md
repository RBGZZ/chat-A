## Why

"会反对 / 不无脑附和"是 canonical §7 明列的**伴侣 vs 助手分水岭、差异化护城河**(原话:三个参考项目都没做,须自创)。当前小雪有人格、有心情、有记忆,但回合生成里**没有任何"坚持己见/表达异议"的机制**——她仍是默认顺从的助手腔。§5.4 PromptAssembler 早已预留了"异议"优先级槽、`assertiveness` 旋钮也已接好线但**没驱动任何行为**。本切片把这条差异化主线的**最小可用形态**落地,直接兑现 §10 验收 rubric 的"反例级:会谄媚吗?会无脑同意吗?"。

## What Changes

- **新增 `self_notions`(她的观点/信念/好恶)**:PersonaCard 可填"她相信什么 / 讨厌什么 / 对什么有看法",作为反对的依据;每条进 `subject=agent` 记忆(可召回,沿用 lore 幂等去重)。无则不影响其余功能。
- **新增 stance / 分歧检测接缝 `StanceDetector`**(异步,沿用 `Appraiser`/`MemoryExtractor` 接缝风格):
  - **确定性默认实现(默认开)**:对本轮 `userText` 做 self_notions 的**话题相关性**命中(关键词/归一化匹配)——只判"这个话题她有看法",**不臆测语义冲突**(冲突由正在生成的 LLM 自行判断,符合"能用代码算的不交给 LLM、算不准的不假装")。
  - **LLM 实现(可选,默认关)**:给定 userText + self_notions 返回更精准的"用户确与某条观点相左",失败降级到确定性实现(承 §3.2)。
- **新增 `DissentContributor`**:插到 §5.4 预留的"异议"优先级槽,据本轮 stance 结果注入——① 一条**反谄媚基线指令**(由 `assertiveness` 调强弱:"你有自己的判断,不必为迎合而附和;不认同就坦诚说出来");② 命中话题时附上相关 `self_notion`("关于 X,你的看法是 …")。
- **`assertiveness` 旋钮端到端接通**:0 = 温和顺从(基线指令不注入、话题命中阈值高)↔ 1 = 敢顶嘴有主见(基线更强、更易触发、措辞更直接)。阈值/措辞全外置,无 magic number。
- **`PromptContext` 增加 `stance` 字段**(由回合编排层 Conversation 填入;assembler 不自行检测,守接缝边界 §3.1)。
- 默认人格骨架已是非顺从口径("会表达不同意见、有自己的边界"),本切片**不重写骨架**,而是补上"每轮主动 steer"的活机制。

Non-goals(本切片不做):

- **自主主动开口 / open threads 跟进**(autonomy,§7#1/#2,P3/P4)。
- **从语音读情绪 prosody**(§7#5,语音轨)。
- **负面 IPC 姿态 SULKING/WITHDRAWN**(§7#6,另开切片)。
- **概率门控/belief 强度模型**(LingYa 式)——本期用 assertiveness 线性调制即可,不引入概率模型。
- 语义级冲突判定的确定性实现——明确交给 LLM(默认靠生成时判断,或 opt-in LLM 检测器)。

## Capabilities

### New Capabilities
- `stance-disagreement`: 小雪据自身 `self_notions` 表达异议、不无脑附和的能力——含 self_notions 来源、StanceDetector 接缝(确定性默认 + LLM 可选)、DissentContributor 注入、assertiveness 旋钮门控。

### Modified Capabilities
- `prompt-assembly`: `PromptContext` 字段集增加 `stance`(本轮分歧检测结果),供 `DissentContributor` 消费;字段仍 MUST 仅来自当轮已有数据、由编排层填入(接缝边界不变)。

## Impact

- **延迟预算(§3.2)**:确定性检测是回合内同步字符串匹配,**首字零额外延迟**;LLM 检测器默认关,开启时与 appraiser 同档(回合后/可降级),不挡流式首字。
- 代码:
  - `@chat-a/persona`:`PersonaSeed`/`PersonaCard` 增 `selfNotions`;card-loader 解析 + 种子化(subject=agent,kind=self_notion);新增 `StanceDetector` 接缝 + `DefaultStanceDetector`(确定性)+ `LlmStanceDetector`(可选);assertiveness→阈值/措辞映射(externalized)。
  - `@chat-a/cognition`:新增 `DissentContributor` + `PROMPT_PRIORITY.dissent` 槽;`PromptContext` 增 `stance` 字段。
  - `@chat-a/runtime` `Conversation`:回合内调 StanceDetector 产出 stance → 填入 PromptContext;注册 DissentContributor。
  - `@chat-a/client` `cli.ts`:`CHAT_A_STANCE=llm` 切 LLM 检测器(默认确定性);横幅显示 stance 模式 + self_notions 条数。
- 数据:self_notions 经现有 `addMemory`(subject/personId 已就位)写入,**无 schema 变更**;幂等去重复用现有机制。
- 已锁决策不受影响:确定性内核优先、接缝哲学、SQLite 真相源、延迟预算均遵循。
