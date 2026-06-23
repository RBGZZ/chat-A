# stance-disagreement Specification

## Purpose
TBD - created by archiving change stance-disagreement. Update Purpose after archive.
## Requirements
### Requirement: self_notions 作为反对依据

PersonaCard SHALL 支持 `self_notions`——Agent 自己的观点/信念/好恶(她相信什么、讨厌什么、对什么有看法),每条至少含可匹配的话题线索与一段立场文本。`self_notions` MUST 全部由配置驱动(用户自治,§6.2),缺省为空且不影响其余功能。每条 `self_notion` SHALL 在启动时作为 `subject=agent` 记忆(kind=`self_notion`)写入 `MemoryStore`(ADD+去重,§5.8),使其可被召回并参与上下文;重复启动 MUST 幂等。

#### Scenario: 卡中 self_notions 装配并种子化

- **WHEN** PersonaCard 提供了一条或多条 self_notions
- **THEN** 每条以 `subject=agent`、kind=`self_notion` 写入存储,且可在装配出的人格数据中被分歧检测访问

#### Scenario: 无 self_notions 不影响功能

- **WHEN** PersonaCard 未提供 self_notions
- **THEN** 装配与回合照常进行,仅不产出针对具体观点的异议

### Requirement: StanceDetector 分歧检测接缝

系统 SHALL 提供 `StanceDetector` 接缝:据本轮用户输入与 `self_notions` 产出本轮 stance 结果(异步签名以容纳 LLM 实现,确定性实现返回已决议 Promise)。系统 SHALL 提供**确定性默认实现**,据用户输入对 self_notions 做话题相关性命中(归一化关键词匹配),只判定"该话题 Agent 有立场",MUST NOT 臆测语义层面的同异(语义冲突交由生成 LLM 判断)。系统 SHALL 允许注入 **LLM 实现**(默认关),其失败时 MUST 降级到确定性实现或空结果,绝不中断回合(§3.2)。检测 MUST 由回合编排层调用,assembler 不自取(§3.1)。

#### Scenario: 话题命中产出 stance

- **WHEN** 用户输入命中某条 self_notion 的话题线索
- **THEN** 检测器返回包含该 self_notion 立场的 stance 结果

#### Scenario: 无命中返回空

- **WHEN** 用户输入与任何 self_notion 话题均不相关
- **THEN** 检测器返回空 stance(不含具体观点)

#### Scenario: LLM 检测器失败降级

- **WHEN** 注入了 LLM StanceDetector 且其调用失败
- **THEN** 回合继续,退回确定性结果或空 stance,不抛出中断回合

### Requirement: DissentContributor 注入异议与反谄媚基线

系统 SHALL 提供 `DissentContributor`,注册到 §5.4 PromptAssembler 的预留"异议"优先级槽(靠近末尾的高 priority),据本轮 `ctx.stance` 与 `assertiveness` 注入:① 一条**反谄媚基线指令**(允许并鼓励她在不认同时坦诚表达、不为迎合而附和);② 当 stance 含具体 self_notion 时,附上该观点供她据以表态。contributor MUST 同步、无 I/O(承接缝契约);无任何可注入内容时 MUST 返回 `null`。

#### Scenario: 命中观点时注入异议段

- **WHEN** 本轮 `ctx.stance` 含一条 self_notion 且 assertiveness 高于触发阈值
- **THEN** 组装出的 system 含反谄媚基线 + 该观点的表态指令,位于靠近末尾的优先级

#### Scenario: 无观点但仍可注入基线

- **WHEN** 本轮无具体 stance 但 assertiveness 高于阈值
- **THEN** 注入反谄媚基线指令(不含具体观点段)

#### Scenario: 温和顺从时不注入

- **WHEN** assertiveness 处于最低档(温和顺从)且无具体 stance
- **THEN** DissentContributor 返回 `null`,不拼入任何异议/基线段

### Requirement: assertiveness 旋钮端到端调制异议

`assertiveness` 旋钮 SHALL 端到端可观测地调制反谄媚行为:低值(温和顺从)抬高话题命中的触发门槛、并弱化/不注入基线指令;高值(敢顶嘴有主见)降低触发门槛、强化基线措辞与异议表达强度。映射阈值与措辞档位 MUST 外置为配置(行为即配置,§3.2),无 magic number。

#### Scenario: 提高 assertiveness 增强异议

- **WHEN** 在同一输入与 self_notions 下提高 `assertiveness`
- **THEN** 注入的异议/基线更易触发且措辞更强,可在组装出的 system 文本上观测到差异

#### Scenario: 最低 assertiveness 趋于顺从

- **WHEN** 将 `assertiveness` 置于最低档
- **THEN** 不注入反谄媚基线,且话题命中需更强相关才产出观点(趋于温和顺从)

### Requirement: 默认人格种子自带非空 self_notions

默认人格种子(小雪,`XIAOXUE_SEED`)SHALL 自带一组非空 `self_notions`(3 条或以上),每条含可匹配的话题线索关键词与一段第一人称立场文本,使确定性 stance 检测在相关话题上有可命中的真实观点——"会反对"落到具体话题,而非空转。用户配置 MUST 仍可整体替换或清空(用户自治,§6.2);本要求只约束**默认**种子非空。

#### Scenario: 默认种子的观点可被确定性检测命中

- **WHEN** 使用默认种子 `XIAOXUE_SEED`,且用户输入命中某条 self_notion 的话题关键词,assertiveness 不低于沉默门槛
- **THEN** `DefaultStanceDetector` 返回该条命中观点(非空 stance)

#### Scenario: 无关话题不命中

- **WHEN** 使用默认种子,用户输入与任何 self_notion 话题均无关
- **THEN** `DefaultStanceDetector` 返回空命中,回合照常进行

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

### Requirement: 回合用持久化+可演化的立场来源

回合编排层 SHALL 经 `SelfNotionsManager`(首启用人格种子 self_notions、之后活在持久化 store)作为分歧检测的立场来源,而非直接读静态种子。每轮分歧检测 SHALL 读 `manager.current()`(反映已演化强度);回合收尾 SHALL 调 `manager.advance(userText, turn)` 推进强度演化。**默认(未注入演化器)行为 MUST 等价当前**:`current()` 等于种子立场、`advance` 为 no-op、stance 命中不变。演化器注入与否 MUST 由配置驱动(opt-in)。

#### Scenario: 默认未注入演化器时等价当前

- **WHEN** 未注入 selfNotionEvolver
- **THEN** 分歧检测用的立场等于人格种子的 self_notions,回合行为与接线前一致

#### Scenario: 立场跨重启持久

- **WHEN** 配置了持久化 store 且立场已演化
- **THEN** 进程重启后回合读到的是演化后的立场(从 store 恢复,而非回退种子)

### Requirement: LlmSelfNotionEvolver

系统 SHALL 提供 `LlmSelfNotionEvolver`(实现 `SelfNotionEvolver`):据本轮用户输入与当前立场,用 LLM 判定"用户确立/强化了哪几条立场",产出 `SelfNotionStrengthDelta[]`。任何失败(异常/乱码/无效/越界)SHALL 降级返回 null(本次不演化),绝不打断回合(§3.2)。强度增量的最终钳制由 `SelfNotionsManager` 接缝侧统一保证。

#### Scenario: LLM 判定确立立场产出增量

- **WHEN** 用户表达强化了某条已有立场且 LLM 正常返回
- **THEN** 演化器产出对应 topicKey 的正向强度增量

#### Scenario: LLM 失败降级不演化

- **WHEN** LLM 调用失败或返回无法解析
- **THEN** 演化器返回 null,立场不变,回合继续

