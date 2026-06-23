# 设计:混合召回打分归一(§5.5,无向量)

## 上下文

现状(§5.5 P1 已落地):`config.ts` 有单一权威纯函数 `decayFactor`(`0.5^(days/H)`,pinned 免衰)、`reinforceImportance`、`recallScore(importance, decay) = importance × decay`;两 store 的 `recall` 都在 JS 层调它排序(SQL/Map 只做关键词候选过滤)。

本切片把"记忆强度单路排序"升级为"多路信号混合归一打分",**不引入向量**(P2)。约束:全部公式收敛进 `config.ts` 单一权威;两 store 调用点同步;`recall` 对外签名/返回类型尽量不变;只改 `packages/memory/**`。

## 关键决策

### 决策 1:单一权威混合公式 `mixedRecallScore`,不替换而是"包住"现有公式

新增 `config.ts` 纯函数 `mixedRecallScore(signals, cfg)`,把每一路信号显式建模成"在场/缺席 + 值 ∈ [0,1]":

```
score = present.length === 0 ? 0 : min( Σ present.value / present.length , 1 )
```

- **记忆强度路**:`recallScore(importance, decay)`(现有单一权威公式)即这路的值。importance∈[0,1]、decay∈(0,1] → 值天然 ∈[0,1]。**恒在场**。
- **关键词路**:见决策 2。**有 token 时在场**(本期 recall 总有 token,否则早返回空)。
- **情感共振路**:见决策 4。**仅当调用方传入 PAD 时在场**。

`recallScore`/`decayFactor`/`reinforceImportance` **不改一行**——继续是各自单一权威公式,`mixedRecallScore` 在它们之上做融合,不另起第二套衰减/强化。这满足"单一权威 + 勿引多套漂移"。

**自适应分母**:分母 = `present.length`(在场信号数),不是固定的"满分信号数 N"。无情感时分母=2(关键词+强度),启用情感时=3;若未来某路缺席分母自动缩——缺席信号不稀释(§5.5)。每路值已 ∈[0,1],平均后仍 ∈[0,1],`min(·,1)` 仅作防御性封顶。

### 决策 2:关键词原始分 → 查询长度自适应 sigmoid 归一

关键词原始分 `raw` = 该候选命中的**查询 token 去重数**(本期 LIKE;未来 FTS5 `bm25()` 同接入点)。经 sigmoid 压到 [0,1]:

```
keywordScore(raw, queryTokenCount, cfg) = 1 / (1 + exp(-s · (raw - m)))
其中 m = clamp( ceil(queryTokenCount · cfg.keywordMidpointFraction), 1, queryTokenCount )
```

- `s` = `cfg.keywordSigmoidSteepness`(陡度,外置,默认见配置)。
- `m`(sigmoid 中点)**随查询长度自适应**:`queryTokenCount · keywordMidpointFraction`(默认比例外置),夹到 `[1, queryTokenCount]`。长查询(多 token)要求命中更多 token 才算"高分",短查询(1 token)中点=1,命中即过半分。这正是 mem0 `scoring.py` 的"查询长度自适应"思想,无 magic number。
- **向后兼容关键**:单 token 查询时所有候选 `raw=1`、`m=1` → `keywordScore` 对所有候选**相同**,排序仍由记忆强度路驱动 → 现有 golden 测试(多为单 token 查询)行为不变。多 token 但每候选只命中一个 token 时同理(各候选 raw 相同)。

### 决策 3:零信号门控(只丢"全零",不学 mem0 语义硬丢)

候选**仅当所有在场信号值都为 0** 时才被门控丢弃。本期关键词候选池由 LIKE/includes 命中产生 → 命中候选 `raw≥1` → `keywordScore>0`(sigmoid 恒 >0)→ 实际不会被门控丢。门控逻辑显式写出并 golden 锁定,是为了**保证语义**:未来关键词分可能为 0(如纯情感召回路径)时,情感单路非零仍能进池;反之亦然。绝不因"某单路低/缺"而硬丢(对比 mem0 反面教训)。

### 决策 4:情感共振——可选 PAD 入参 + Russell 扇区常量矩阵(O(1))

- `recall` 签名**仅追加一个可选末位入参** `pad?: Pad`(默认 `undefined` → 不启用情感共振)。返回类型不变。cognition/runtime 现有调用零改动(向后兼容)。
- `Pad` 为 memory 包**本地最小类型**(`{pleasure, arousal, dominance}`,各 [-1,1]),结构与 persona 包的 `Pad` 兼容但**不 import persona**(§3.1 不跨包依赖内部;memory 不依赖 persona)。
- 情感共振值 `emotionResonance(pad, record, cfg)`:把"当前 PAD 状态"与"记忆的情感色彩"各投影到 **Russell 2D VA 扇区**(由 pleasure/arousal 象限定 4 扇区 + 中性),查 **5×5 常量矩阵**得共振系数 ∈[0,1](O(1) 查表,§5.5)。本期记忆无 `emotion_snapshot` 落库(v4 预留列,P2 才写)→ 记忆侧扇区在本期由**记忆主语/极性的保守缺省**推出,矩阵对角线(同扇区)高、跨扇区低;缺信息时取中性扇区。矩阵为常量、外置在 config 模块顶层(非 magic number 散落)。
- 重排"小幅":情感共振只是混合式里**一路在场信号**,与关键词/强度等权平均——不单独乘性放大、不主导排序,避免"情感强但完全跑题"的记忆霸榜。

### 决策 5:候选过滤带出命中数,两 store 同契约

两 store 的候选过滤已逐 token 匹配;把"该候选命中的去重 token 数"一并算出传入 `mixedRecallScore`:
- InMemory:`tokens.filter(t => r.normalized.includes(t)).length`。
- SQLite:仍用 LIKE 取候选行,命中数在 JS 层用同一 `normalized_text includes token` 复算(单一规则,与 InMemory 零漂移;不依赖 SQL 端计数,避免两套)。

排序后的次级键(hits、id)与强化时机(返回排序确定后再强化)**完全不变**。

## 风险 / 权衡

- **golden 漂移风险**:混合式改变了 score 绝对值。已论证单/多-token-单命中场景下关键词路对候选恒定 → 相对排序不变,现有 golden 全绿;新增 golden 锁多 token 差异命中、自适应分母、零信号门控、情感开关。
- **情感侧本期信息有限**:记忆未落 `emotion_snapshot`,情感共振用保守缺省扇区 → 本期情感重排作用温和;P2 接入 `emotion_snapshot` 后同一接缝增强,矩阵/公式不变。
- **并行冲突**:只改 `packages/memory/**`;`recall` 可选入参向后兼容 → 不破其它包。`pnpm -r typecheck` + 全量 vitest 验收未改包不受影响。
