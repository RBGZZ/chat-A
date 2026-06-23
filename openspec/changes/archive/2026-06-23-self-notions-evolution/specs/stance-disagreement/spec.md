# stance-disagreement Specification (delta)

## ADDED Requirements

### Requirement: self_notions 可持久化并跨会话续接

系统 SHALL 让 `self_notions` 从只读种子变为**可持久化**:首次启动用人格种子的 `self_notions` 作初始集(seed),之后立场集 MUST 活在持久化存储中(复用现有 `PersonaStore`/`KvLike` 接缝,独立 KV key,MUST NOT 污染 OCEAN/PAD 的 `persona:snapshot`)。持久化结构 MUST 带 schema 版本字段。当存储缺失或损坏/解析失败时,系统 MUST 回落到种子 `self_notions`(优雅降级,§3.2),绝不空手或崩溃。

#### Scenario: 首启用种子并落库

- **WHEN** 提供了存储且其中尚无 self_notions 状态
- **THEN** 系统以种子 `self_notions` 初始化并落库一份带 schema 版本的状态,后续读取得到该状态

#### Scenario: 跨重启读回演化后的立场

- **WHEN** 立场状态(含强度)已写入存储,随后以同一存储重建管理器
- **THEN** 读回的立场集等于此前保存的状态(含强度与版本快照)

#### Scenario: 存储缺失或损坏回落种子

- **WHEN** 存储不存在、解析失败或顶层结构非法
- **THEN** 系统回落到种子 `self_notions`,不抛出、不丢功能

### Requirement: self_notions schema 版本与迁移

`self_notions` 持久化 SHALL 带 schema 版本号并提供迁移路径(数据迁移纪律,§6.1/§3.2)。读取到的旧形态(无版本号、或缺少强度等新字段)MUST 被迁移补齐为当前版本的缺省值,且迁移 MUST NOT 丢失任何立场的 `topic`/`position`(立场状态绝不因迁移而丢)。版本快照 `history` 若损坏(非数组)MUST 被丢弃该字段而非丢弃整份立场状态。

#### Scenario: 旧形态无版本号被迁移补齐

- **WHEN** 读取到无 schema 版本号的旧 self_notions 形态(如纯 `SelfNotion[]` 数组,各条缺强度字段)
- **THEN** 迁移为当前版本,逐条补齐强度/计数缺省值,且每条的 topic 与 position 原样保留

#### Scenario: 立场条目损坏整体回落

- **WHEN** 读取到的立场集字段(notions)非数组或结构损坏
- **THEN** 视作无状态并回落种子,而非带病续接

#### Scenario: history 损坏不殃及立场

- **WHEN** 持久化状态中版本快照 history 形状非法(非数组)
- **THEN** 丢弃 history 字段但保留立场集(topic/position/strength)

### Requirement: self_notion 保守强度演化(opt-in)

`SelfNotion` SHALL 支持可选的**立场强度**与确立计数(纯加法字段,旧种子/旧快照缺省时按基线处理,行为不变)。系统 SHALL 提供 `SelfNotionEvolver` 接缝(异步签名容纳 LLM,沿用 §3.1 opt-in 范式),在对话中某立场被确立/强化时产出**正向**强度增量。每次强度增量 MUST 被钳制在单次上限内(保守,只增不减),且 MUST 追加一条版本快照(可回溯/可回滚,§6.1)。强度演化 **默认关**:未注入 evolver 时立场强度恒定、不写快照(默认行为严格等价当前只读种子)。演化的任何失败/无信号/全零增量 MUST 跳过本次、不打断回合、不抛(§3.2)。单次上限与基线强度 MUST 外置为配置(行为即配置,无 magic number)。

#### Scenario: 确立某立场抬升其强度

- **WHEN** 注入了 SelfNotionEvolver 且其判定本轮确立/强化了某条立场
- **THEN** 该立场强度上升一个不超过单次上限的增量,确立计数加一,并追加一条版本快照

#### Scenario: 增量超上限被钳制

- **WHEN** evolver 返回的强度增量超过单次上限
- **THEN** 实际应用的增量被钳制到单次上限,强度不会一步突变

#### Scenario: 未注入 evolver 立场恒定

- **WHEN** 未注入 SelfNotionEvolver
- **THEN** 立场强度全程恒定、不产生版本快照,等价于当前只读种子行为

#### Scenario: 演化失败或无信号降级

- **WHEN** evolver 抛错、返回 null、或返回全零/无效增量
- **THEN** 本次不演化、立场不变、不写快照、回合不受影响、不抛出

### Requirement: stance 检测读演化后的立场强度

确定性 `StanceDetector` SHALL 能读取立场的(演化后)强度并据以保守地调制表达:对**显式标注了低强度**的立场,在低 assertiveness 下更趋沉默(更难产出异议)。缺省未标强度的立场(如旧种子)MUST 按基线"足够"处理,使其命中行为与当前完全一致(不破现有 stance 行为)。强度压制门槛 MUST 外置为配置。

#### Scenario: 缺省强度立场命中行为不变

- **WHEN** 立场未标注强度(旧种子),用户输入命中其话题且 assertiveness 不低于沉默门槛
- **THEN** 检测器返回该立场,行为与当前只读种子完全一致

#### Scenario: 显式低强度立场更易沉默

- **WHEN** 某立场被显式标注为低强度,且 assertiveness 处于较低档
- **THEN** 即便话题命中,该低强度立场也更易被压制(趋于沉默)
