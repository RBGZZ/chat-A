## ADDED Requirements

### Requirement: 负面人际姿态(SULKING/WITHDRAWN)

系统 SHALL 在既有 PAD/离散情绪之上提供一层**负面人际姿态** `Posture`:`sulking`(赌气:心情差且高唤醒)与 `withdrawn`(冷淡抽离:心情差且低唤醒)。姿态 MUST 为确定性纯函数(由 PAD + `negativeAffectExpression` 旋钮派生,可写 golden test,承 §6.1 单一权威公式)。`negativeAffectExpression` SHALL 端到端门控:低于触发档时**不产生任何负面姿态**(永远愉悦、不闹脾气,即便 PAD 为负);达到/高于触发档时进入姿态,且 tone 中姿态指令的强度随档增强。SULKING 与 WITHDRAWN 的区分 MUST 按 arousal 高低(沿用 irritated/down 的分法)。阈值与措辞档位 MUST 外置为配置,无 magic number。

#### Scenario: 心情差 + 高表达档 → 进入负面姿态

- **WHEN** PAD 处于低 Pleasure 且 `negativeAffectExpression` 高于触发档
- **THEN** 解析出负面姿态(高 arousal→sulking / 低 arousal→withdrawn),且渲染的 tone 含对应【姿态】行为指令

#### Scenario: 低表达档则压住坏脾气

- **WHEN** PAD 同样为负但 `negativeAffectExpression` 低于触发档
- **THEN** 不产生负面姿态,tone 不含姿态指令(保持亲社会语气)

#### Scenario: 心情不差则无姿态

- **WHEN** PAD 的 Pleasure 不处于负面区间
- **THEN** 不产生负面姿态(姿态是负面态的叠加层,非常态)

#### Scenario: 姿态强度随旋钮升高

- **WHEN** 在同一负面 PAD 下提高 `negativeAffectExpression`
- **THEN** 注入的姿态措辞更强(可在 tone 文本上观测到从克制到明显的差异)
