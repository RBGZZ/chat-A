## Context

§7#3「会反对」是差异化护城河,但回合生成里目前零机制。可复用的接缝已就位:
- **§5.4 PromptAssembler**:`PROMPT_PRIORITY` 预留间隙(100/500/900)给"情绪/未了话题/**异议**"contributor;`PromptContributor.contribute(ctx)` 同步、无 I/O;单 contributor 抛错优雅降级已是契约。
- **PersonaCard**(刚落地):卡 + env 装配 + 种子化 lore(subject=agent)的模式可直接套到 self_notions。
- **接缝风格先例**:`Appraiser`(DefaultAppraiser/LlmAppraiser)、`MemoryExtractor`(Noop/Llm)——"确定性内核默认 + LLM 可选 opt-in + 失败降级"。
- **`assertiveness` 旋钮**已在 `PersonaDials`,但 persona-emotion spec 注明 personality_dials "P1 部分接入",尚未驱动任何行为。
- 默认 `identity` 已非顺从("会表达不同意见、有自己的边界"),故无需重写骨架。

约束:延迟预算(确定性检测同步、首字零延迟)、接缝边界(assembler/contributor 不自取 detector/persona)、优雅降级、行为即配置(阈值/措辞外置)、数据迁移纪律(不动 memory schema)。

## Goals / Non-Goals

**Goals:**
- self_notions 作为反对依据(卡可填、进 subject=agent 记忆)。
- StanceDetector 接缝:确定性默认(话题相关性,默认开)+ LLM 可选(默认关、降级)。
- DissentContributor 注入反谄媚基线 + 命中观点,挂预留优先级槽。
- assertiveness 端到端可观测调制触发阈值 + 异议强度。

**Non-Goals:**
- autonomy 主动开口 / open threads(P3/P4)、prosody(语音轨)、负面 IPC 姿态 #6。
- 概率/belief 强度模型(LingYa 式)——本期线性调制。
- 确定性语义冲突判定——交给生成 LLM 或 opt-in LLM 检测器。

## Decisions

### D1:确定性检测器默认**开**,只判"话题相关",不判"语义冲突"

差异化是"会反对",默认关就仍是助手。确定性检测无 LLM 成本、回合内同步、零额外延迟 → **默认开**。它只做 self_notions 的话题关键词命中(复用 memory 的归一化/分词思路),**不臆测用户是否真冲突**——把"用户到底同不同意"留给正在生成的 LLM(它有全文,判得准)。这守住"能用代码算的算、算不准的不假装"(§3.2)。**备选**:确定性做语义冲突判定(脆弱、易误伤,弃);默认关(违背北极星,弃)。

### D2:StanceDetector 接缝,沿用 Appraiser 形态

```ts
interface StanceContext { userText: string; selfNotions: readonly SelfNotion[]; assertiveness: number; }
interface StanceResult { notions: readonly SelfNotion[]; }   // 命中的观点(可空)
interface StanceDetector { detect(ctx: StanceContext): Promise<StanceResult>; }
```
`DefaultStanceDetector`(确定性命中)+ `LlmStanceDetector`(opt-in,返回更精准的"用户确与某条相左",失败→退确定性/空)。异步签名容纳 LLM;确定性返回已决议 Promise。**编排层(Conversation)调用**,结果填进 `PromptContext.stance`。**备选**:让 contributor 自己检测——但 contributor MUST 同步无 I/O,放不下 LLM 路径,且要持有 self_notions、违反接缝边界,弃。

### D3:self_notions 结构 + 存放

```yaml
self_notions:
  - topic: [咖啡, coffee, 提神]     # 话题线索(关键词命中)
    position: 我觉得手冲比速溶值得，慢一点的东西更有味道。
```
`SelfNotion = { topic: readonly string[]; position: string }`。放在 `PersonaSeed`/`PersonaCard`,**检测用种子上的显式列表**(不靠 recall——recall 是全库关键词,不精准)。同时**种子化进记忆**(subject=agent, kind=`self_notion`),保持"她的观点也是她的自我记忆"一致性 + 未来语义召回受益(沿用 lore 幂等)。**备选**:只进记忆不留种子(检测拿不到结构化 topic,弃)。

### D4:DissentContributor 注入两段,assertiveness 分档

挂新槽 `PROMPT_PRIORITY.dissent`(靠近末尾、tone 之后,本轮最强 steer):
- **反谄媚基线**(仅由 assertiveness 门控,与有无观点无关):assertiveness ≤ 低档阈值 → 不注入(温和顺从);中/高 → 注入,措辞随档增强("可以委婉提出不同看法" → "不必附和,不认同就直说")。
- **观点段**(当 ctx.stance 有命中):附"关于 X,你的立场是:…;若用户看法不同,坦诚表达、给理由,不要为迎合改立场"。
- 无任何可注入 → 返回 `null`(守契约)。tier 用 `peripheral`(段短、排在末尾,预算压力下才会被裁,实际不会触顶);**理由**:不污染 core 语义,且短指令几乎不被裁。

assertiveness→{触发阈值, 措辞档} 的映射表 externalized 到 persona 配置常量(无 magic number)。

### D5:不重写骨架,补"每轮活 steer"

默认 identity 已含"会表达不同意见"。静态骨架是常驻底色,但"这一轮要不要顶、顶哪条"是动态的 → 用 DissentContributor 每轮注入。骨架不改 = 既有契约/快照不破。

### D6:LLM 检测器走回合内但不挡首字

确定性检测同步、回合前算完填 ctx。LLM 检测器(opt-in)若开:与现有 appraiser 同档处理——可在组装前 await(增首字延迟,故默认关 + 文档标注),或退化为"仅确定性 + 生成时判断"。本期 LLM 检测器**默认关**,确定性 + 生成 LLM 判断已能"会反对"。

## Risks / Trade-offs

- **她变得爱抬杠/为反对而反对** → 反谄媚基线措辞强调"不认同**才**表达、要给理由",且 assertiveness 默认 0.5(中性);确定性只在话题命中时给观点,不命中只给温和基线。文档建议从低 assertiveness 起调。
- **关键词命中误伤(话题相关≠观点相关)** → 接受:命中只是"把她的看法摆上桌 + 允许异议",不是"强制反对";真正判不判冲突交给 LLM。opt-in LLM 检测器可提精度。
- **基线指令被预算裁剪导致静默失效** → 段极短 + 排末尾高优先级,实际不会触顶;若担心可后续升 core。本期 peripheral + 注释说明。
- **self_notions 重复种子** → 幂等去重(承 §5.8),与 lore 同。
- **assertiveness 同时被 §7 其它项(主动性/负面姿态)复用** → 本切片只接 assertiveness→异议;不碰 proactivity/negativeAffect(各自切片),避免旋钮语义打架。

## Migration Plan

1. `@chat-a/persona`:加 `SelfNotion` 类型 + `selfNotions` 到 PersonaSeed/PersonaCard;card-loader 解析(字段级容错,沿用 coerce);种子化 helper 扩展(写 subject=agent kind=self_notion)。
2. `@chat-a/persona`:`StanceDetector` 接缝 + `DefaultStanceDetector`(确定性命中,复用 memory 归一化思路或自带)+ `LlmStanceDetector`(opt-in);assertiveness→阈值/措辞映射常量。
3. `@chat-a/cognition`:`PromptContext` 加 `stance?`;`PROMPT_PRIORITY.dissent`;`DissentContributor`。
4. `@chat-a/runtime` `Conversation`:回合内 await detector → 填 ctx.stance;注册 DissentContributor。
5. `@chat-a/client`:`CHAT_A_STANCE=llm` 切 LLM 检测器;横幅显示 stance 模式 + self_notions 条数;example 卡补 self_notions 示例。
6. 测试:DefaultStanceDetector golden(命中/不命中)、DissentContributor(基线/观点/null、assertiveness 分档)、card-loader self_notions 解析/容错/种子化主语、Conversation 接线、降级。
7. **回滚**:self_notions 留空 + assertiveness 低档 → 等价当前(无异议注入);无 schema 变更,可安全回退。

## Open Questions

- 反谄媚基线的**默认是否在 assertiveness=0.5 注入**?倾向"是,但措辞温和"(中性人格也该有一点点主见);最低档才完全不注入。apply 时定档位边界。
- `DefaultStanceDetector` 的话题匹配是否直接复用 `@chat-a/memory` 的 tokenize/normalize(需 persona→memory 依赖,已有 test devDep 先例)还是 persona 自带轻量归一?倾向自带轻量(避免运行时依赖),apply 时定。
