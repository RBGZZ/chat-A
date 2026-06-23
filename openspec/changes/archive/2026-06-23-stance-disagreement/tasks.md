## 1. self_notions（类型 + 卡 + 种子化）

- [x] 1.1 `persona/types.ts`:新增 `SelfNotion = { topic: readonly string[]; position: string }`;`PersonaSeed`/`PersonaCard` 增 `selfNotions?: readonly SelfNotion[]`;`LoadedPersonaCard` 增 `selfNotions`
- [x] 1.2 `persona/card-loader.ts`:解析 `self_notions`(字段级容错——topic 取字符串数组、position 取非空串,非法条目丢弃);默认种子 selfNotions 缺省为空
- [x] 1.3 `persona/seed-memories.ts`:`seedPersonaMemories` 扩展——遍历 selfNotions 以 `{ subject:'agent', kind:'self_notion', text: position }` 写入(幂等);返回值加 `selfNotions` 计数

## 2. StanceDetector 接缝

- [x] 2.1 `persona/types.ts`:`StanceContext`/`StanceResult`/`StanceDetector` 接缝类型(detect 异步)
- [x] 2.2 `persona/stance.ts`:`DefaultStanceDetector`——对 userText 归一化后命中 selfNotions 的 topic 关键词,产出命中观点列表;assertiveness 调触发门槛(命中需达的相关度/最多返回条数);轻量自带归一(不引 memory 运行时依赖)
- [x] 2.3 `persona/stance.ts`:`LlmStanceDetector`(opt-in)——provider 调用返回更精准命中,容错 JSON + 失败降级到确定性/空(沿用 LlmAppraiser 风格)
- [x] 2.4 `persona`:assertiveness→{触发阈值, 措辞档} 映射常量(externalized,无 magic number);`index.ts` 导出新类型/实现

## 3. DissentContributor + PromptContext

- [x] 3.1 `cognition/prompt/types.ts`:`PromptContext` 增 `stance?: StanceResult`(或等价轻量结构,避免 cognition→persona 强耦合,优先在 cognition 内定义最小 stance 形状)
- [x] 3.2 `cognition/prompt/config.ts`:`PROMPT_PRIORITY.dissent`(tone 之后,如 950),带注释
- [x] 3.3 `cognition/prompt/contributors.ts`:`DissentContributor`——据 ctx.stance + assertiveness 注入①反谄媚基线(assertiveness 门控+分档措辞)②命中观点段;无内容返回 null;同步无 I/O
- [x] 3.4 `cognition/prompt/index.ts` 导出 DissentContributor

## 4. 回合接线（runtime + client）

- [x] 4.1 `runtime/conversation.ts`:`ConversationDeps` 增 `stanceDetector?`;构造期默认 `DefaultStanceDetector`;注册 `DissentContributor` 到 assembler
- [x] 4.2 `runtime/conversation.ts`:回合内(组装前)await `stanceDetector.detect({userText, selfNotions, assertiveness})` → 填 `PromptContext.stance`;detect 抛错兜底空 stance（§3.2）
- [x] 4.3 selfNotions 来源:从 personaSeed 取 + 提供给 detector（Conversation 持有 seed.selfNotions）
- [x] 4.4 `client/cli.ts`:`CHAT_A_STANCE=llm` 切 `LlmStanceDetector`(默认确定性);种子化 selfNotions（经 seedPersonaMemories）;横幅显示 stance 模式 + self_notions 条数

## 5. 测试（golden + 契约 + 降级）

- [x] 5.1 `DefaultStanceDetector` golden:命中 topic→返回观点;不命中→空;assertiveness 低档抬高门槛（同输入低档不命中/高档命中）
- [x] 5.2 `DissentContributor`:有观点→基线+观点段;无观点高 assertiveness→仅基线;最低 assertiveness 无观点→null;措辞随档变化可观测
- [x] 5.3 card-loader:self_notions 解析正确 + 非法条目丢弃 + 缺省为空;seed-memories：selfNotions 写 subject=agent/kind=self_notion 且幂等
- [x] 5.4 `Conversation`:注入自定义 StanceDetector→system 含异议段;detector 抛错→回合不中断、无异议段（降级）
- [x] 5.5 LlmStanceDetector：失败降级到确定性/空（record-replay 或 fake provider）

## 6. 文档与收尾

- [x] 6.1 `persona.example.yaml` 补 `self_notions` 示例 + 注释（含"建议从低 assertiveness 起调"）
- [x] 6.2 `start.bat`/说明:`CHAT_A_STANCE`、assertiveness 与"会反对"的关系
- [x] 6.3 全量 `pnpm typecheck` + `pnpm test` 通过;手动冒烟:填 self_notions + 提高 assertiveness → 对话中她对相关话题表达不同看法、不无脑附和
