## Context

§6.1「自我一致性锚定」是 §0 七维「一致性(自我连贯·不自相矛盾)」的落地。可复用接缝已就位:
- **§5.4 PromptAssembler**:`PROMPT_PRIORITY` 留间隙(100/500/900/920/950)给后续 contributor;`PromptContributor.contribute(ctx)` 同步无 I/O,单 contributor 抛错优雅降级已是契约。
- **接缝风格先例**:`Appraiser`/`StanceDetector`/`SelfNotionEvolver`——"确定性内核 + LLM 可选 opt-in + 失败降级"。`LlmSelfNotionEvolver` 已示范"complete + 要 JSON + `tolerantJsonParse` + 失败降级"。
- **§5.3 自我记忆**:`subject=agent` 记忆(种子 lore kind=`self_lore` / self_notions kind=`self_notion` / 涌现自我事实)可经 `MemoryStore.recall` 召回;§5.4 核心档含"Agent:名字/core_belief/根本设定"。
- **接缝边界(§3.1)**:persona 不依赖 memory 包(`KvLike` 同款手法);故"语义召回核心自我记忆"由**编排层**完成,Guard 只消费**注入的召回结果**(最小结构端口 `SelfMemoryRef`)。

约束:延迟预算(确定性同步、首字零延迟;LLM 在回复后)、接缝边界(persona 不 import memory 内部、不依赖 embedder)、优雅降级(失败=不锚定)、行为即配置(开关/严格度/词表外置)、**缺省安全(默认关,行为字面不变)**、数据迁移纪律(不动 schema)。

## Goals / Non-Goals

**Goals:**
- `SelfConsistencyGuard` 接缝:确定性默认(保守、golden 可测)+ LLM 可选(schema 约束、降级)。
- 漂移仅指"否定核心设定";观点偏离/"我不同意"/新喜好**不算**(放宽阈值)。
- 漂移→`ReAnchorContributor` 温和重锚(注入下轮 steer,不改写回复)。
- `enabled` 缺省 false(缺省安全)+ `strictness` + 词表外置;决策 trace sink。

**Non-Goals:**
- autonomy/prosody/负面姿态;回复改写 pass;memory recall API/schema 改动;embedding 相似度内核(语义召回在 persona 之外)。

## Decisions

### D1:确定性 Guard 默认**保守**,只判"显式否定核心锚点",绝不判"语义矛盾"

漂移检测的本质是语义判断,确定性"猜语义矛盾"既不可信又极易误伤(把"我不同意你"当漂移正是 §6.1 警告的反模式)。故确定性内核**只**做一件可代码精确算、可 golden 的事:对**核心锚点**(`name` + 显式标注 `core` 的自我断言)做**否定线索模式**命中——回复里同时出现 `否定词(不/不是/没/并非…)` 与某核心锚点关键词,才记为候选漂移。**它对一切不命中核心锚点否定模式的输入返回"不漂移"**——观点变化、"我不同意""我改主意了"、新喜好、情绪波动全部落在"不漂移",这就是"放宽阈值"在确定性侧的落地(§3.2 能用代码算的才算,算不准的不假装语义判定)。**备选**:确定性做 embedding 相似度/语义矛盾(脆弱+引 embedder 依赖,弃);默认开(可能误伤 + 改变既有行为,违背硬约束,弃)。

### D2:`SelfConsistencyGuard` 接缝形态(沿用 Appraiser/StanceDetector)

```ts
/** 核心自我记忆的最小注入结构(编排层用既有 recall(subject=agent) 召回后传入;persona 不依赖 memory)。 */
interface SelfMemoryRef {
  readonly text: string;        // 记忆文本(如「我叫小雪」「我相信慢下来更有味道」)
  readonly kind?: string;       // self_lore / self_notion / core_belief 等(仅作权重提示)
  readonly core?: boolean;      // 是否核心档(§5.4;true=根本设定,确定性侧只锚 core+name)
}
interface SelfConsistencyContext {
  readonly reply: string;                          // 本轮回复(候选/已生成文本)
  readonly selfMemories: readonly SelfMemoryRef[]; // 语义召回的核心自我记忆(编排层注入)
  readonly agentName?: string;                     // 人格名字(name 是最强核心锚点)
}
interface AnchorResult {
  readonly drift: boolean;            // 是否与核心自我矛盾
  readonly reason?: string;           // 判定理由(trace/重锚用)
  readonly anchorText?: string;       // 命中的核心锚点(供重锚提示「以此为准」)
}
interface SelfConsistencyGuard {
  check(ctx: SelfConsistencyContext): Promise<AnchorResult>;
}
```
异步签名容纳 LLM;确定性返回已决议 Promise。**编排层在回复生成后**调 `check` → 填 `PromptContext.anchor`(供**下一轮** ReAnchorContributor 注入,本期不二次生成本轮回复)。**备选**:contributor 自检——MUST 同步无 I/O,放不下 LLM + 违反接缝边界,弃。

### D3:`DefaultSelfConsistencyGuard` 算法(确定性、保守、golden 可测)

输入归一化(小写+去空白,与 stance/self-notions 一致)。锚点集合 = `agentName`(若有)+ `selfMemories` 中 `core===true` 的条目(strictness 高档可放宽到全部自我记忆,但**默认只锚 core+name**)。对每个锚点抽"锚定关键词"(name 本身;core 记忆取其显著名词/短语近似——用配置词表 + 记忆文本切分的简单启发,**不做语义**)。判漂移当且仅当:回复中**同时**出现「否定线索词(外置 `NEGATION_CUES`,如 不/不是/不叫/没有/并非/才不/再也不…)」**邻近**某锚点关键词(同句/近窗口)。否则 `drift=false`。**只增不臆测**:无锚点、无否定线索、或否定线索未邻接核心锚点 → 一律不漂移。这天然让"我不同意(用户的观点)""我喜欢上了X"不命中(它们不否定 name/core 自我断言)。

### D4:`LlmSelfConsistencyGuard`(opt-in,schema 约束 + 降级)

`complete` + system「你是自我一致性检测器,只输出 JSON」+ prompt 列出核心自我记忆 + 回复,要求输出 `{"drift":bool,"reason":string}`。prompt **显式放宽阈值**:「只有当回复**否定了**这些核心设定(名字/根本信念/根本人设)才算 drift=true;**观点改变、不同意对方、产生新喜好、情绪波动都不算 drift**」。`tolerantJsonParse` 解析,校验 `drift` 为 boolean;任何失败(异常/乱码/字段缺失)→ 返回 `{drift:false}`(**降级为不锚定**),记 `onError`。沿用 `LlmSelfNotionEvolver` 形态。

### D5:重锚 = `ReAnchorContributor`(温和、只在漂移时注入)

cognition 新增 `ReAnchorContributor`:`ctx.anchor?.drift === true` 时注入一段高优先级 steer:「[自我一致性] 你刚才的说法和你确立过的自我不太一致(`anchorText`);请以你确立过的自我为准,自然地把它说回正——但**你完全可以有不同观点、改主意、有新喜好**,那些不必收回,只是别否定你是谁/你根本相信什么。」无 anchor 或 `drift=false` → 返回 null(默认路径零注入)。`PROMPT_PRIORITY.reAnchor` 放在 dissent(950)之后(如 980)——重锚是"守住自我"的最强压轴 steer,但措辞克制不否定个性。cognition 自定义最小 `AnchorInput { drift; anchorText? }`,不强耦合 persona 类型(同 StanceInput 手法)。

### D6:行为即配置 + 缺省安全

`SelfConsistencyConfig { enabled: boolean; strictness: 'core-only'|'all-self'; }`,默认 `{ enabled:false, strictness:'core-only' }`。`DefaultSelfConsistencyGuard` 构造可注入 config + 否定词表 + 锚点关键词最小长度等(全外置,无 magic number)。**`enabled=false` 时 Guard 永远返回 `{drift:false}`**(等价不锚定),编排层据此不注入 ReAnchor → **行为字面不变**(硬约束:既有测试全绿)。

### D7:可追溯(§8.1,sink 接缝,不强依赖)

Guard 可选 `onDecision(d: { drift; reason?; anchorText?; mode:'default'|'llm' })` 回调:判定后调用一次,供编排层落 SQLite 决策 trace(经现有 trace 接缝)。persona 侧**只留 sink 接缝**,不 import observability(接缝边界);不注入 = 不记。

## Risks / Trade-offs

- **确定性内核保守 → 漏报**:很多真实"否定核心自我"是语义级的(确定性命中不了)。接受——本期确定性默认就是"宁可漏报不误伤"(误伤把个性拉回比漏报更违背北极星);真召回靠 opt-in LLM Guard。golden test 覆盖"命中否定核心锚点→漂移"与"观点偏离/不同意→不漂移"两侧。
- **重锚是下轮 steer 而非本轮改写**:本轮可能仍吐了矛盾句;接受(§7#3 已记录"生成后改写 pass"暂缓,避免强制+二次延迟)。下轮温和拉回符合"像人会自我修正"。
- **核心自我记忆召回质量**取决于编排层(语义召回在 persona 外);Guard 只对"被喂进来的"锚定,召回空=不锚定(降级)。

## Migration

无数据迁移:不动 memory schema、不改既有持久化。纯加法接缝 + 缺省关。
