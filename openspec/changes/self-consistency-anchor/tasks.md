## 1. persona 接缝类型 + 配置

- [x] 1.1 `persona/types.ts`:新增 `SelfMemoryRef { text; kind?; core? }`、`SelfConsistencyContext { reply; selfMemories; agentName? }`、`AnchorResult { drift; reason?; anchorText? }`、`SelfConsistencyGuard { check(ctx): Promise<AnchorResult> }`、`SelfConsistencyConfig { enabled; strictness }`、`SelfConsistencyDecision`(sink 载荷:drift/reason?/anchorText?/mode)——**纯追加,不重排既有类型**
- [x] 1.2 `persona/defaults.ts`:外置常量——`DEFAULT_SELF_CONSISTENCY_CONFIG = { enabled:false, strictness:'core-only' }`、`NEGATION_CUES`(不/不是/不叫/没有/没/并非/才不/再也不…)、`ANCHOR_KEYWORD_MIN_LEN`、邻接窗口等(无 magic number)

## 2. 确定性 Guard(内核,golden 可测)

- [x] 2.1 `persona/self-consistency.ts`:`DefaultSelfConsistencyGuard implements SelfConsistencyGuard`——构造接 `config`/否定词表/`onDecision`(全可选);`enabled=false` 时永远返回 `{drift:false}`(缺省安全)
- [x] 2.2 锚点集合:`agentName` + `selfMemories` 中 `core===true`(strictness `core-only`);`all-self` 放宽到全部;归一化(小写+trim,与 stance/self-notions 一致,纯函数)
- [x] 2.3 判漂移规则:回复出现否定线索词 **且** 邻接某核心锚点关键词 → `drift:true` + `anchorText`;否则 `false`。纯函数、可写 golden
- [x] 2.4 判定后调 `onDecision({drift,reason?,anchorText?,mode:'default'})`(若注入)

## 3. LLM Guard(opt-in,schema 约束 + 降级)

- [x] 3.1 `persona/llm-self-consistency.ts`:`LlmSelfConsistencyGuard`——`complete` + system「只输出 JSON」+ prompt 列核心自我记忆 + 回复,要 `{"drift":bool,"reason":str}`;prompt **显式放宽阈值**(只否定核心设定才算 drift;不同意/改主意/新喜好不算)
- [x] 3.2 `tolerantJsonParse` 解析 + 校验 `drift` 为 boolean;任何失败 → `{drift:false}`(降级不锚定)+ `onError`/`onDecision(mode:'llm')`;沿用 `LlmSelfNotionEvolver` 形态(provider/maxTokens/onError 可配)
- [x] 3.3 `persona/index.ts` 导出 `self-consistency` + `llm-self-consistency` 全部新类型/实现

## 4. cognition 重锚 contributor

- [x] 4.1 `cognition/prompt/types.ts`:`PromptContext` 增 `anchor?: AnchorInput`(cognition 自定义最小 `AnchorInput { drift; anchorText? }`,不强耦合 persona,同 StanceInput 手法)
- [x] 4.2 `cognition/prompt/config.ts`:`PROMPT_PRIORITY.reAnchor`(dissent=950 之后,如 980),带注释
- [x] 4.3 `cognition/prompt/contributors.ts`:`ReAnchorContributor`——`ctx.anchor?.drift===true` 时注入温和重锚 steer(以确立过的自我为准 + **明确保留个性偏离**);否则 null;同步无 I/O
- [x] 4.4 `cognition/prompt/index.ts` 经 `export * from './contributors'` 自然导出(确认 `ReAnchorContributor`/`PROMPT_PRIORITY.reAnchor` 可从 `@chat-a/cognition` 取到)

## 5. 测试(golden + schema + 降级 + 回归)

- [x] 5.1 `persona/test/self-consistency.test.ts`:`DefaultSelfConsistencyGuard` golden——① 否定核心锚点(name / core 记忆)→ `drift:true`+anchorText;② "我不同意你"→ `drift:false`;③ 改主意/新喜好 → `drift:false`;④ 无否定线索 → `false`;⑤ 否定线索但远离锚点 → `false`;⑥ `enabled:false` 对任何输入 → `false`(缺省安全)
- [x] 5.2 `persona/test/llm-self-consistency.test.ts`:FakeLlm 注入——返回 `{"drift":true,...}` → 漂移;返回乱码/抛错 → 降级 `{drift:false}`(不触网);`onDecision`/`onError` 被调
- [x] 5.3 `cognition/test/re-anchor.test.ts`:`ReAnchorContributor`——drift:true → 非 null + priority=reAnchor + 含"保留个性"语义;无 anchor / drift:false → null
- [x] 5.4 `cognition/test/prompt-assembler.test.ts`(若已有等价用例则补一条):带 `anchor` 的 ctx 组装正常;无 anchor 等价现状(对外等价回归)
- [x] 5.5 回归:`npx vitest run`(persona + cognition 既有用例全绿)+ `pnpm -r typecheck` 全绿

## 6. 校验

- [x] 6.1 `npx openspec validate self-consistency-anchor --strict` 通过
