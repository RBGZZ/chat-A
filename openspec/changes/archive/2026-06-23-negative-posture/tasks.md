## 1. 姿态内核（persona）

- [x] 1.1 `persona/types.ts`:新增 `export type Posture = 'sulking' | 'withdrawn'`
- [x] 1.2 `persona/posture.ts`:`POSTURE`(floor/pleasureCeil/arousalSplit)+ `POSTURE_TEXT[posture][band]` 外置常量;`resolveNegativePosture(pad, dials): Posture | null`(确定性:nae<floor→null、pleasure>ceil→null、否则按 arousal 分);`renderPostureLine(posture, dials): string | null`(据 nae 分档取措辞)
- [x] 1.3 `persona/tone.ts` `renderToneFragment`:在情绪行后,若姿态非空则追加 `【姿态】<措辞>`
- [x] 1.4 `persona/engine.ts` `ToneView` 加 `posture: Posture | null`;`tone()` 计算并返回(复用 resolveNegativePosture)
- [x] 1.5 `persona/index.ts` 导出 `Posture` / posture.ts

## 2. 决策 trace 接姿态（observability）

- [x] 2.1 `observability/decision-trace.ts`:`DecisionTrace` 增 `readonly posture?: string`
- [x] 2.2 `observability/sqlite-decision-trace.ts`:`CURRENT_TRACE_SCHEMA_VERSION=2` + 迁移 v2(`ALTER TABLE decision_traces ADD COLUMN posture TEXT`);`record` 写 `trace.posture ?? null`(INSERT 列 + 占位)

## 3. 回合接线（runtime）

- [x] 3.1 `runtime/conversation.ts` `#recordTrace`:入参加 posture;构造 trace 时 `...(posture ? { posture } : {})`
- [x] 3.2 `send()` 收尾调用处:传 `mood.posture ?? undefined`

## 4. 测试

- [x] 4.1 `resolveNegativePosture` golden:负面+高 arousal→sulking;负面+低 arousal→withdrawn;nae<floor→null(压住);pleasure 非负→null
- [x] 4.2 分档:同一负面 PAD 下 nae 克制档 vs 强档,`renderPostureLine` 措辞不同(可观测)
- [x] 4.3 `renderToneFragment`:姿态激活时含【姿态】行;nae 低时不含
- [x] 4.4 trace v2:全新库建 v2 含 posture 列;v1 旧库重开迁移到 v2 补列、历史行 posture=NULL、不丢数据
- [x] 4.5 `record`:posture 往返(写 sulking → 查回 sulking;无姿态 → NULL)
- [x] 4.6 `Conversation`:高 negativeAffectExpression + 负面情绪回合 → trace.posture 落库且 system 含【姿态】(可用 spy sink + 拉低 PAD 多轮或注入 appraiser)

## 5. 文档与收尾

- [x] 5.1 `persona.example.yaml`:注释 `negativeAffectExpression` 与 SULKING/WITHDRAWN 的关系(低=永远愉悦,高=会赌气冷淡;建议从低起调)
- [x] 5.2 全量 `pnpm typecheck` + `pnpm test` 通过;手动冒烟:高 negativeAffectExpression + 连续负面输入 → 她语气转冷/话少,trace 里 posture 落库
