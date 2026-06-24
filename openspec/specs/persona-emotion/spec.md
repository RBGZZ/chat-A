# persona-emotion Specification

## Purpose
TBD - created by archiving change persona-emotion-core. Update Purpose after archive.
## Requirements
### Requirement: OCEAN 种子映射 PAD 基线

系统 SHALL 由 OCEAN 人格五维(确定性地)计算出 PAD(Pleasure/Arousal/Dominance)基线,使用单一权威的 Mehrabian 系数公式(§6.1)。映射 MUST 是纯函数、无副作用、可写 golden test;相同 OCEAN 输入恒得相同 PAD 基线。

#### Scenario: 相同 OCEAN 恒定映射

- **WHEN** 用同一组 OCEAN 值两次计算 PAD 基线
- **THEN** 两次结果完全相同,且各维落在合法区间(如 [-1, 1])

#### Scenario: 高宜人性/外向性抬高愉悦度基线

- **WHEN** OCEAN 的宜人性与外向性显著高于中性
- **THEN** PAD 的 Pleasure 基线高于中性映射的结果

### Requirement: PAD 弹簧回归基线

PAD 状态 SHALL 按单一权威公式向基线回归:`new = cur + 0.3·pull − k·(cur − baseline)`,交互时 `k=0.2`、空闲时 `k=0.01`(§6.1)。该步进 MUST 为纯函数(给定 cur/pull/baseline/k 恒定可测),并将结果钳制在合法区间。

#### Scenario: 无外力时向基线收敛

- **WHEN** 连续多步施加 `pull=0`(交互 k)
- **THEN** PAD 单调向基线靠近且不越过基线(收敛)

#### Scenario: 正向 pull 抬高当前情绪

- **WHEN** 在某状态上施加正向 pull
- **THEN** 新状态较旧状态更偏正向,偏移量符合公式

### Requirement: 冷启动情绪抑制

系统 SHALL 提供冷启动:前若干轮(可配置)将情绪幅度减半并加速回弹,避免早期过拟合(§6.1,chat-A 自有设计)。冷启动窗口与系数 MUST 外置为配置。

#### Scenario: 冷启动期幅度减半

- **WHEN** 在冷启动窗口内施加与窗口外相同的 pull
- **THEN** 冷启动内产生的情绪偏移小于窗口外(约减半)

#### Scenario: 冷启动结束后恢复正常幅度

- **WHEN** 轮次超过冷启动窗口
- **THEN** 情绪步进使用正常(未减半)幅度

### Requirement: 用户可调人格/情感旋钮

`personality_dials`(assertiveness / negative_affect_expression / proactivity / intimacy_pace)与 `emotion_dials`(emotional_intensity / emotional_volatility / baseline_warmth / expressiveness)SHALL 全部外置为配置(行为即配置,§3.2),无 magic number,缺省有默认。旋钮 MUST 可观测地改变内核行为:`emotional_volatility` 调制 spring `k`、`emotional_intensity` 调制 pull 幅度、`baseline_warmth` 调制 Pleasure 基线、`expressiveness` 调制 tone 外显。

#### Scenario: 提高波动性改变回归速率

- **WHEN** 提高 `emotional_volatility`
- **THEN** 情绪回归/反应的有效 `k`(或幅度)随之改变,可在步进结果上观测

#### Scenario: 提高基础温暖抬高愉悦基线

- **WHEN** 提高 `baseline_warmth`
- **THEN** 计算出的 PAD Pleasure 基线随之升高

### Requirement: 情绪状态注入对话语气

每个回合系统 SHALL 将当前 PAD 映射到最近的离散情绪,并据此 + 旋钮渲染一段动态 tone fragment(warmth/mood/expressiveness),拼入该回合的 system prompt(§6.1 tone 注入)。PAD→离散情绪与 tone 文本渲染 MUST 为确定性、可写 golden test。

#### Scenario: 心情差则 tone 体现低落

- **WHEN** PAD 处于低 Pleasure 状态时渲染 tone fragment
- **THEN** 生成的 tone 文本体现低落/冷淡基调(与高 Pleasure 状态的 tone 文本不同)

#### Scenario: tone fragment 进入回合 system

- **WHEN** 一个回合发起
- **THEN** 传给 LLM 的 system 包含当轮渲染的 tone fragment(在静态人格骨架之后)

### Requirement: Appraiser 接缝

每轮施加到 PAD 的 pull SHALL 来自可替换的 `Appraiser` 接缝(§3.1);上层只依赖接口。系统 MUST 提供一个确定性默认实现(零额外网络延迟),使心情随对话起伏可用;LLM 版评估为可选实现,默认关闭,启用时不得阻塞流式首字之前的路径之外引入未声明延迟(§3.2)。

#### Scenario: 默认确定性 appraiser 可用

- **WHEN** 未配置任何 LLM appraiser,正常进行回合
- **THEN** 每轮产生确定性的 PAD pull,情绪随之步进,不发起额外网络调用

#### Scenario: appraiser 可替换

- **WHEN** 注入一个自定义 Appraiser 实现
- **THEN** 回合使用该实现产出的 pull,内核其余逻辑不变

### Requirement: OCEAN/PAD 持久化与跨重启恢复

OCEAN 与 PAD 状态 SHALL 持久化到 SQLite 真相源(复用 `@chat-a/memory`,§8.1),进程重启后心情/人格连续(从上次状态续接,而非重置基线)。持久化 schema MUST 带版本,迁移不丢状态(§3.2);首启无状态时用种子初始化。

#### Scenario: 重启后续接心情

- **WHEN** 演化出一个偏离基线的 PAD 状态并持久化,然后重启重建人格内核
- **THEN** 读回的 PAD 等于持久化时的值(而非基线)

#### Scenario: 首启用种子初始化

- **WHEN** 无任何已存状态时初始化人格内核
- **THEN** OCEAN 取种子值、PAD 取由种子算出的基线

### Requirement: 用户自定义角色背景与用户画像

系统 SHALL 允许用户通过一个外置 **PersonaCard 配置文件(YAML)**自定义角色与画像,作为用户自治(§6.2)的权威创作入口:角色身份/背景/说话风格(成为人格种子,身份摘要进 system prompt 静态骨架)、OCEAN 五维与情感旋钮、问候语,以及多条用户画像(写入 `subject=person` 主用户的种子记忆,经已落地的 `MemoryStore`)。全部 MUST 可编辑、由配置驱动;卡缺省时 SHALL 回落到内置默认种子(等价既有 XIAOXUE,行为不破)。环境变量(`CHAT_A_PERSONA_NAME`/`CHAT_A_PERSONA_IDENTITY`/旋钮等)SHALL 降为覆盖层:卡存在时按字段覆盖卡值,卡缺省时仍单独生效(向后兼容)。

#### Scenario: 角色身份进入人格骨架

- **WHEN** 卡中提供了角色身份/说话风格
- **THEN** 回合 system 的静态骨架包含该身份描述

#### Scenario: 用户画像成为种子记忆

- **WHEN** 卡中提供了一条或多条用户画像且尚无对应记忆
- **THEN** 每条画像作为 `subject=person`(主用户)记忆被写入存储,后续可被召回

#### Scenario: env 覆盖卡内字段

- **WHEN** 同时存在 PersonaCard 且设置了对应环境变量(如 `CHAT_A_PERSONA_NAME`)
- **THEN** 装配出的种子采用环境变量的值(env 覆盖卡值),其余字段仍取自卡

#### Scenario: 无卡时回落默认并兼容 env

- **WHEN** 未指定 PersonaCard
- **THEN** 装配出等价默认种子;若设置了既有环境变量,则其覆盖默认种子对应字段

### Requirement: PersonaCard 配置文件加载与容错

系统 SHALL 提供一个 **纯函数加载器**,从 `CHAT_A_PERSONA_CARD` 指定路径读取 YAML PersonaCard,产出人格种子(name/identity/OCEAN 五维/旋钮/greetings)与待种子化的输入(自我 lore 列表、用户画像列表),加载器 MUST 不直接依赖或改写 `MemoryStore` 内部(接缝边界,§3.1)。卡文件缺失、YAML 解析失败或字段类型非法时,加载器 SHALL 优雅降级到默认种子并发出告警,绝不抛出导致进程崩溃(§3.2);非法的单个数值字段(如越界 OCEAN/旋钮)SHALL 回落该字段默认值而非整卡失败。

#### Scenario: 完整卡装配出自定义种子

- **WHEN** 提供了一个含 name/identity/ocean 五维/dials/greetings 的合法 YAML 卡
- **THEN** 加载器返回的人格种子各字段取自卡,且 OCEAN 五维均生效(不再受限于仅 name/identity/旋钮可改)

#### Scenario: 卡文件不存在时降级

- **WHEN** `CHAT_A_PERSONA_CARD` 指向不存在的文件
- **THEN** 加载器返回默认种子并发出告警,不抛异常

#### Scenario: YAML 解析失败时降级

- **WHEN** 卡文件内容不是合法 YAML 或顶层结构非法
- **THEN** 加载器返回默认种子并发出告警,不抛异常

#### Scenario: 单字段非法只回落该字段

- **WHEN** 卡中某 OCEAN 维或旋钮值越界 [0,1]
- **THEN** 该字段回落默认值,卡其余合法字段仍生效

### Requirement: 角色背景/故事作为可召回的自我 lore

系统 SHALL 把 PersonaCard 中的角色背景/故事条目(`lore`)在启动时作为 `subject=agent` 的种子记忆写入 `MemoryStore`(ADD+去重,§5.8),使其能被后续关键词召回参与回合上下文;这些长背景 MUST NOT 整体塞入静态 system 骨架(避免 prompt 膨胀,骨架只含身份摘要 `identity`)。重复启动 SHALL 幂等(依赖既有去重,不产生重复条目)。

#### Scenario: lore 写入为 agent 主语记忆

- **WHEN** 卡中提供了一条或多条 lore 背景
- **THEN** 每条以 `subject=agent` 写入存储,且不出现在静态骨架文本中

#### Scenario: 重复启动幂等

- **WHEN** 以同一张卡重复启动
- **THEN** 既有 lore/画像记忆不被重复新建(命中去重)

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

### Requirement: 二级 OCEAN delta 演化(慢变量)

系统 SHALL 每隔可配置的 N 轮(默认 20)触发一次二级 OCEAN 信号分析,据近段对话给 OCEAN 五维产出一个微调 delta 并写回 OCEAN(§6.1 delta 演化)。触发节拍判定与 delta 应用 MUST 为确定性、可写 golden test;演化能力默认关闭(未注入 `OceanEvolver` 时 OCEAN 恒定)。

#### Scenario: 满 N 轮触发演化

- **WHEN** 已注入 `OceanEvolver` 且回合推进到第 N 的整数倍轮
- **THEN** 该轮触发一次 OCEAN 二级演化,OCEAN 被(钳制后的)delta 微调

#### Scenario: 未满 N 轮不演化

- **WHEN** 已注入 `OceanEvolver` 但当前轮次不是 N 的整数倍
- **THEN** 本轮不触发 OCEAN 演化,OCEAN 维持不变

#### Scenario: 默认关闭

- **WHEN** 未注入任何 `OceanEvolver`,正常推进任意轮数
- **THEN** OCEAN 始终等于种子/上次值,不发起任何演化相关调用

### Requirement: 单次 OCEAN delta 钳制上限

系统 SHALL 把单次演化的每维 OCEAN delta 钳制在可配置上限内(默认 ±0.01),且应用后的 OCEAN 维度钳回合法区间 [0,1](§6.1)。钳制 MUST 为纯函数,即使信号源返回越界值也不得突破上限。

#### Scenario: 越界 delta 被钳到上限

- **WHEN** 信号分析返回某维 delta 远超上限(如 +1)
- **THEN** 实际应用的该维 delta 不超过 +0.01(上限),OCEAN 仍落在 [0,1]

#### Scenario: 非有限 delta 视作零

- **WHEN** 信号分析某维返回 NaN/Infinity 等非有限值
- **THEN** 该维 delta 视作 0,OCEAN 该维不变

### Requirement: OCEAN 演化版本快照 history

每次实际发生的 OCEAN 演化 SHALL 追加一条版本快照(含旧 OCEAN、新 OCEAN、实际 delta、触发轮次、时间戳)到持久化 history,以支持回溯/回滚(§6.1 版本快照 history,数据迁移纪律)。快照构造 MUST 为确定性、可写 golden test。

#### Scenario: 演化写入一条快照

- **WHEN** 一次演化实际改变了 OCEAN
- **THEN** history 追加恰好一条快照,其 before=旧 OCEAN、after=新 OCEAN、delta=已钳制的实际 delta、turn=触发轮次

#### Scenario: 跳过的演化不写快照

- **WHEN** 信号分析返回空(不演化)或全零 delta
- **THEN** history 不新增条目,OCEAN 不变

### Requirement: OCEAN 演化失败优雅降级

OCEAN 二级演化基于可注入的 `OceanEvolver` 接缝(§3.1),且 MUST 全程优雅降级:无 LLM、调用异常、返回乱码或无有效维度时,本次演化被跳过,OCEAN 与回合均不受影响(§3.2 优雅降级)。LLM 版实现照 `complete + tolerantJsonParse + 失败降级` 范式,默认关闭、opt-in。

#### Scenario: 解析失败跳过演化

- **WHEN** 注入的 LLM `OceanEvolver` 在触发轮返回无法解析为有效 delta 的内容
- **THEN** 本次演化被跳过,OCEAN 不变,回合正常完成,不抛出异常

#### Scenario: 合规 JSON 经钳制后应用

- **WHEN** 注入的 LLM `OceanEvolver` 在触发轮返回合规的五维 delta JSON(含越界值)
- **THEN** 各维 delta 被钳到 ±上限后应用到 OCEAN,并写入一条版本快照

### Requirement: 持久化快照向后兼容 history 字段

持久化的 `PersonaSnapshot` SHALL 以向后兼容的加法扩展出可选的 OCEAN 演化 history 字段;读取旧快照(无 history)MUST 正常恢复人格状态(视作空 history),且 history 字段损坏绝不导致人格状态(OCEAN/PAD/turn)丢失(§3.2 数据迁移纪律,人格状态绝不丢)。

#### Scenario: 旧快照无 history 正常读回

- **WHEN** 加载一个不含 history 字段的旧持久化快照
- **THEN** OCEAN/PAD/turn 正常恢复,history 视作空,不报错

#### Scenario: history 损坏不丢人格状态

- **WHEN** 持久化快照的 history 字段形状非法,但 OCEAN/PAD/turn 合法
- **THEN** 人格状态(OCEAN/PAD/turn)仍被正常恢复,不因 history 损坏而整体回退种子

### Requirement: 关系亲密度 closeness 调制 tone(单向 → 表达)

tone 渲染 SHALL 可接受**关系亲密度** `closeness`(承 §6.1b / §2.4)并据其调制语气的**温暖度、自我披露深度、称呼亲昵度**。closeness MUST 按外置的三档阈值(`midLow`/`midHigh`，无散落 magic number)落档：

- **亲近档**(高于 `midHigh`)：语气更暖、更愿意主动分享自己的事和感受、可用更亲昵的称呼。
- **疏远档**(低于 `midLow`)：语气礼貌而克制、少做自我披露、保持适当距离。
- **适中档**(两阈值之间)：不追加关系语气行(关系不显著，省 token)。

closeness MUST **单向影响表达**，绝不反改 OCEAN/PAD 或情绪(关系只调语气，不污染人格/情绪状态)。`closeness` 参数 MUST 可选：**省略时 tone 输出 MUST 逐字等于未引入 closeness 前的旧行为**(向后兼容)；透传 MUST 满足 exactOptional 安全(仅在提供时附带实参，绝不显式传 undefined)。落档 MUST 确定性(同一 closeness 恒落同档)。

#### Scenario: 高 closeness 注入更暖/愿分享的语气

- **WHEN** 以高于 `midHigh` 的 closeness 渲染 tone
- **THEN** tone 文本含亲近档指令(更暖、愿分享、更亲昵称呼)

#### Scenario: 低 closeness 注入克制/少披露的语气

- **WHEN** 以低于 `midLow` 的 closeness 渲染 tone
- **THEN** tone 文本含疏远档指令(礼貌克制、少自我披露)，且与高 closeness 的输出不同

#### Scenario: 适中档不追加关系语气行

- **WHEN** 以介于两阈值之间的 closeness 渲染 tone
- **THEN** 不追加任何【关系】语气行

#### Scenario: 省略 closeness 逐字等于旧行为

- **WHEN** 渲染 tone 时不传 closeness(或传 undefined)
- **THEN** 输出与未引入 closeness 前逐字一致，不追加任何关系行

#### Scenario: closeness 不反改人格与情绪

- **WHEN** 以任意 closeness 渲染 tone
- **THEN** OCEAN/PAD 与离散情绪不因 closeness 改变(closeness 仅单向调语气)

### Requirement: prosody 情绪映射 PAD 拉力(确定性内核)

系统 SHALL 提供确定性纯函数 `prosodyToPadPull(emotion?, map?)`,把 STT 读出的离散 prosody 情绪标签(§7#5「从语音读情绪」)映射成 PAD 拉力 `PadPull`,供 §6.1 `stepPad` 消费,使「怎么说的」与文本 appraiser 的「说了什么」并轨喂入 PAD 情绪内核。该函数 MUST 为纯函数(同入参输出全等,可 golden test),映射表 MUST 外置可配(`DEFAULT_PROSODY_PAD_MAP`,行为即配置、无 magic number、可注入覆盖)。

入参 MUST 用结构类型(`{ label: string; confidence?: number }`),使 persona **不依赖 providers 包**(接缝边界 §3.1)。映射 MUST 覆盖 qwen3-asr 的 7 类情绪(surprised/neutral/happy/sad/disgusted/angry/fearful);各维拉力结果 MUST 钳制到 `[-1,1]`。`emotion` 为 `undefined` / `label` 不在表内 / `label==='neutral'` 时 MUST 返回**零拉力** `{pleasure:0,arousal:0,dominance:0}`(安全降级:`stepPad` 仅按基线回归、不施加语音拉力)。若 `confidence∈(0,1]` 则拉力 MUST 按 confidence 线性缩放,缺省视作 1(不缩放)。

#### Scenario: 7 类情绪映射为确定性 PAD 拉力

- **WHEN** 以 `{label:'sad'}`、`{label:'happy'}`、`{label:'angry'}` 等分别调用 `prosodyToPadPull`
- **THEN** 各返回 `DEFAULT_PROSODY_PAD_MAP` 中对应的 `PadPull`(如 sad 为负 pleasure/负 arousal/负 dominance、happy 为正 pleasure 等),且两次同入参调用结果全等

#### Scenario: 缺省/未知/中性情绪返回零拉力

- **WHEN** 以 `undefined`、`{label:'neutral'}`、或 `{label:'__unknown__'}` 调用 `prosodyToPadPull`
- **THEN** 返回零拉力 `{pleasure:0,arousal:0,dominance:0}`(喂 `stepPad` 不改变语音侧贡献,链路对无情绪信号优雅降级)

#### Scenario: 置信度线性缩放拉力

- **WHEN** 以 `{label:'sad', confidence:0.5}` 调用 `prosodyToPadPull`
- **THEN** 返回的拉力各维为 `sad` 基准拉力 × 0.5(确定性可断言);`confidence` 缺省或非 `(0,1]` 时不缩放

### Requirement: PAD 情绪步进可并入语音 prosody 拉力

`PersonaEngine.advance` SHALL 在既有「文本 appraiser 拉力 → `stepPad` 步进」流程基础上,接受一个**可选**第二参数 `opts?: { prosodyEmotion?: SttEmotionLike }`,使 §7#5「从语音读情绪」可影响 PAD 情绪内核(§6.1)。当提供 `opts.prosodyEmotion` 时,`advance` MUST 经 `prosodyToPadPull(opts.prosodyEmotion)` 得语音侧拉力,与 appraiser 产出的文本拉力 `textPull` **按权重合并**为 `merged`:`merged_axis = clampUnit(textPull_axis + W · prosodyPull_axis)`(各维钳制 `[-1,1]`),其中 `W` MUST 为外置具名常量(`PROSODY_PULL_WEIGHT`,默认 `0.5`,行为即配置、无 magic number、语音为辅不盖文本),再以 `merged` 做**单次** `stepPad` 步进(与无语音时同一次步进,绝不二次步进/二次回归)。

当**未提供** `opts` 或 `opts.prosodyEmotion` 为 `undefined` 时,`advance` 的行为 MUST 与现状**逐字一致**:即所用拉力等于 `textPull`、经同一次 `stepPad` 步进,产出的 PAD / OCEAN 演化 / 持久化快照与本 change 前完全相同(纯加法、向后兼容、回归硬线)。入参 `prosodyEmotion` MUST 用结构类型 `SttEmotionLike`(`{ label: string; confidence?: number }`),使 persona **不依赖 providers 包**(接缝边界 §3.1)。`prosodyToPadPull` 对 `undefined`/未知/`neutral`/低 confidence 的优雅降级(零拉力/线性缩放)MUST 原样沿用——故提供一个 neutral/未知标签的 `prosodyEmotion` 时合并拉力等于 `textPull`,行为与不提供等价。

#### Scenario: 提供 prosody 情绪使 PAD 朝该情绪方向偏移

- **WHEN** 以注入了零文本拉力 appraiser 的 `PersonaEngine` 调 `advance('随便说点', { prosodyEmotion: { label: 'sad' } })`
- **THEN** 本轮 `stepPad` 的拉力为 `W · prosodyToPadPull({label:'sad'})`(负 pleasure/负 arousal/负 dominance),推进后 PAD 的 pleasure 较「不提供 prosody」时更低(语音情绪真实影响心情)

#### Scenario: 不提供 prosody 与现状逐字一致

- **WHEN** 以同一 seed/appraiser 分别跑 `advance(userText)` 与本 change 前的 `advance(userText)`
- **THEN** 两者产出的 PAD、turn、OCEAN、持久化快照逐字相等(golden:纯加法不改默认路径)

#### Scenario: neutral / 未知 prosody 标签等价于不提供

- **WHEN** 调 `advance(userText, { prosodyEmotion: { label: 'neutral' } })`
- **THEN** 因 `prosodyToPadPull` 对 neutral 返回零拉力,合并拉力等于 `textPull`,推进结果与 `advance(userText)` 全等(优雅降级)

#### Scenario: 语音拉力按外置权重 W 弱于文本(为辅不盖)

- **WHEN** 同一 prosody 情绪以权重 `W=PROSODY_PULL_WEIGHT`(默认 0.5)合并
- **THEN** 合并后语音侧对各维的贡献为 `W·prosodyPull`,严格弱于同量级文本拉力(语音为辅,§7#5 不喧宾夺主)

