## Why

canonical §7#6 / §6.1 指出:现有情绪态(joyful/content/neutral/down/irritated)**偏"亲社会"**,缺"赌气/冷淡/我现在不想说话"这类**负面人际姿态**——而"会闹脾气、心情差真的会表现出来"正是伴侣 vs 助手的分水岭之一。`negativeAffectExpression` 旋钮**已定义但从未接线**。本切片把负面姿态 SULKING(赌气)/ WITHDRAWN(冷淡抽离)落地,由该旋钮门控("永远愉悦不闹脾气" ↔ "完整表达坏心情/会赌气冷淡"),并把姿态记入刚落地的决策 trace。

## What Changes

- **新增负面人际姿态** `Posture = 'sulking' | 'withdrawn'`(在既有 PAD/情绪之上的一层人际行为姿态):
  - **SULKING(赌气)**:心情差且**有气**(arousal 高)——语气冷带刺、明显话少、可"哼"一下、不主动延展,但不伤人。
  - **WITHDRAWN(冷淡/不想说话)**:心情差且**蔫**(arousal 低)——回应很短、平淡抽离,可明确"现在不太想聊"。
- **`negativeAffectExpression` 旋钮端到端门控**(确定性):< 低档 → **不摆姿态**(永远愉悦,即便 PAD 负也压住);中/高档 → 进入姿态且措辞随档增强。SULKING vs WITHDRAWN 按 arousal 分(沿用 irritated/down 的高/低唤醒分法)。
- **tone 注入扩充**:姿态激活时在 tone fragment 追加一行【姿态】行为指令;旋钮低则不注入(保持现有亲社会语气)。
- **姿态进决策 trace**(§8.1):`DecisionTrace` 增 `posture` 字段,SqliteDecisionTraceSink schema v2 加列迁移;Conversation 把当轮姿态一并落库(完整可重放新行为决策)。

Non-goals(本切片不做):

- **完整 IPC 圆环模型**(LingYa 全套人际姿态):本期只补两个负面姿态 + 旋钮门控,不引入完整圆环。
- **姿态影响打断/主动性/通道占用**(autonomy 层,P3/P4)。
- **正面姿态扩充**(本期只补负面缺口;正面 5 态已够)。
- **prosody / 语音表达姿态**(语音轨)。

## Capabilities

### Modified Capabilities
- `persona-emotion`: 新增"负面人际姿态(SULKING/WITHDRAWN)"——在 PAD/情绪之上加一层由 `negativeAffectExpression` 门控的确定性人际姿态,激活时注入 tone。
- `decision-trace`: `DecisionTrace` 决策链增 `posture` 字段(当轮负面姿态,可空),纳入"完整可重放"范畴。

## Impact

- **延迟预算(§3.2)**:姿态解析是回合内确定性纯函数(PAD+旋钮),**首字零额外延迟**。
- 代码:
  - `@chat-a/persona`:`Posture` 类型 + `resolveNegativePosture(pad, dials)` 纯函数 + 阈值/措辞常量(externalized);`renderToneFragment` 注入姿态行;`ToneView` 暴露 `posture`。
  - `@chat-a/observability`:`DecisionTrace` 增 `posture?`;`SqliteDecisionTraceSink` schema v2(ALTER TABLE 加列)。
  - `@chat-a/runtime` `Conversation`:把 `mood.posture` 传入 `#recordTrace`。
- 数据:决策 trace 库 schema **v1→v2**(加 `posture` 可空列,顺序迁移,不丢历史);记忆库不动。
- 已锁决策:确定性内核优先、行为即配置(无 magic number)、延迟预算、数据迁移纪律均遵循;承 §6.1 单一权威公式(姿态由同一 PAD 派生)。
