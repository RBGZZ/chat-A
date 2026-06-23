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

