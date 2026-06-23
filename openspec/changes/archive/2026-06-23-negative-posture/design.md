## Context

现状:PAD → `padToEmotion` → 5 情绪(joyful/content/neutral/down/irritated)→ `renderToneFragment` 出 tone 文本。`negativeAffectExpression` 旋钮在 `PersonaDials` 里但 tone 只用了 baselineWarmth/expressiveness。§7#6/§6.1 要补"负面人际姿态"(赌气/冷淡),并由该旋钮控表达程度。已落地的 decision-trace 记 emotion+pad,但未记姿态。

可复用:`stance-disagreement` 的"旋钮分档门控 + 确定性派生 + 注入 tone-后段"模式;`decision-trace` 的版本化迁移手法(memory/trace 库均有先例)。

约束:确定性纯函数(golden test)、延迟预算(回合内同步)、行为即配置(阈值/措辞外置)、数据迁移纪律(trace 库 v1→v2 不丢历史)、§6.1 单一权威公式(姿态与情绪同源 PAD)。

## Goals / Non-Goals

**Goals:**
- 两个负面姿态 SULKING/WITHDRAWN,确定性由 PAD+旋钮派生,`negativeAffectExpression` 端到端门控 + 分档强度。
- 激活时注入 tone【姿态】行为指令;低档压住(保持亲社会)。
- 姿态进 ToneView + DecisionTrace(schema v2)。

**Non-Goals:**
- 完整 IPC 圆环;姿态影响打断/主动性(autonomy);正面姿态扩充;prosody。

## Decisions

### D1:姿态是负面态的叠加层,不替换情绪

emotion(5 态)继续驱动【当前情绪】基调;posture 是更强的**人际行为**叠加,仅在负面区激活,追加【姿态】行为指令。二者同源 PAD、不矛盾(§6.1 单一公式)。**备选**:把姿态并进 Emotion 枚举——会混淆"情绪状态"与"人际行为",且冲击既有 padToEmotion/tone 契约,弃。

### D2:`resolveNegativePosture(pad, dials): Posture | null`(确定性,旋钮门控)

```
nae = dials.negativeAffectExpression
if nae < POSTURE.floor            → null   // 永远愉悦不闹脾气
if pad.pleasure > POSTURE.pleasureCeil → null   // 心情没差到要摆姿态
return pad.arousal >= POSTURE.arousalSplit ? 'sulking' : 'withdrawn'
```
阈值外置常量 `POSTURE = { floor:0.2, pleasureCeil:-0.35, arousalSplit:0 }`。`floor` 与 stance 的 STANCE_FLOOR 同值同义(温和/顺从档),但各自独立常量(同 stance-disagreement 评审的取舍:不跨包耦合一个 0.2)。`pleasureCeil=-0.35` 与 `padToEmotion` 的负面边界一致(同源)。**强度分档**:nae∈[floor,0.6) 克制档、≥0.6 强档(沿用 DISSENT_ASSERTIVENESS 形状),控措辞强弱。

### D3:措辞模板外置(无 magic 文本散落)

`POSTURE_TEXT[posture][band]` 四条(sulking/withdrawn × 克制/强),如:
- sulking 克制:"此刻有点赌气,语气可以微冷、话少一点,但别太过。"
- sulking 强:"此刻在赌气,语气冷淡带刺、明显话少,可以'哼'一下、不主动延展话题,但不伤人。"
- withdrawn 克制:"此刻不太想多说,回应简短、平淡些。"
- withdrawn 强:"此刻很不想说话、情绪抽离,回应很短很冷,可以直说'现在不太想聊'。"

`renderToneFragment` 在情绪行后追加 `【姿态】<POSTURE_TEXT>`(姿态为 null 则不加)。

### D4:ToneView 暴露 posture;Conversation 落 trace

`ToneView` 加 `posture: Posture | null`(继 pad 之后,additive)。`Conversation.#recordTrace` 把 `mood.posture ?? undefined` 传入;`DecisionTrace` 加 `posture?: string`。

### D5:decision-trace 库 schema v1→v2

`SqliteDecisionTraceSink` 加迁移 v2:`ALTER TABLE decision_traces ADD COLUMN posture TEXT;`,`CURRENT_TRACE_SCHEMA_VERSION=2`。旧库顺序迁移补列(历史行 posture 为 NULL),不重建、不丢数据。record 写 `trace.posture ?? null`。

## Risks / Trade-offs

- **她变得动不动就冷脸/赌气** → 默认 `negativeAffectExpression=0.5`(中性):需 PAD 真的转负(pleasure≤-0.35)才进姿态,且默认中档措辞克制;低档完全压住。文档建议从低起调。承"人格默认中性"[[persona-default-and-adjustment]]。
- **trace 库迁移**(加列) → 用 ALTER ADD COLUMN 顺序迁移(幂等、不丢历史),复刻已验证手法;新增测试覆盖 v1→v2。
- **floor 0.2 与 stance 重复** → 沿用既有评审取舍:同义不同包,各自独立常量、勿跨包耦合;均有注释。
- **姿态与 stance 叠加**(高 assertiveness + 负面姿态)→ 两段都注入(立场 + 姿态),语义不冲突(有主见 + 心情差),由各自旋钮独立控制。

## Migration Plan

1. `@chat-a/persona`:`Posture` 类型 + `posture.ts`(`resolveNegativePosture` + `POSTURE`/`POSTURE_TEXT` 常量);`renderToneFragment` 注入;`ToneView` + `engine.tone()` 暴露 posture;index 导出。
2. `@chat-a/observability`:`DecisionTrace.posture?`;`SqliteDecisionTraceSink` v2 迁移 + record 写列。
3. `@chat-a/runtime`:`#recordTrace` 传 posture。
4. 测试:resolveNegativePosture golden(门控/分档/sulking-vs-withdrawn/非负无姿态)、renderToneFragment 含姿态行、trace v2 迁移 + posture 落库、Conversation 落 posture。
5. 文档:persona.example.yaml 注释 negativeAffectExpression 与姿态关系。
6. **回滚**:`negativeAffectExpression` 置 0(或低档)→ 无姿态,等价当前;trace v2 列可空,降级回 v1 代码会因 schema_version 高而拒绝打开(符合现有保护),如需回滚删库或保留(可空列对旧代码无害,但版本号守卫会拒——属预期,记录在案)。

## Open Questions

- `arousalSplit=0` 的取值:sulking/withdrawn 边界,后续据体感微调(外置常量,易改)。
- 是否让姿态也影响 §7#4 生成纪律(更短回复)——本期只给文字指令,真正"截断长度"留待对话风格切片。
