# 设计:行为/人格层设计更新（簇 A,2026-06-23）

> 来源:5 路 GitHub 类似项目调研(`docs/github-learnings-2026-06-23.md`)。本 spec 只覆盖**簇 A:行为/人格层**;簇 B(记忆算法升级)、簇 C(端侧/工程)各自后续。
> 影响:canonical `docs/chat-a-canonical-design.md` 的 §7 / §7#3 / §6 / §5.3b;新增一个轻量"关系亲密度"特性(唯一含实质代码项)。

## 0. 目标与非目标
**目标**:① 修正 §7 失实的"护城河"措辞并吸收最佳前作判断力;② 补齐"关系"这条慢变量轴(单标量 `closeness`);③ 把"反谄媚交由系统判断、非强制"确立为原则,并引入只测不逼的回归指标。

**非目标(明确排除/暂缓)**:
- ❌ 强制反谄媚机制(同意连击熔断器 / 主动性硬下限 / 生成后改写 pass)——**已记录,暂不采纳**,留未来可选/eval。
- ❌ 关系状态多维化(trust/familiarity/affection)——**升级路径已留**(JSON 预留),本次只做单标量。
- ❌ closeness 反向影响 OCEAN/PAD——**单向**(只影响表达),避免难调反馈环。
- ❌ 回归指标进入运行时强制路径——**仅 eval/测量**。

## 1. §7 行为/主动性:措辞修正 + 判断力增益（canonical 文档编辑 + prompt 设计）

### 1.1 诚实修正(纯文档)
- 删去 §7 中"三参考项目自主性全是定时器触发、从不评估是否值得开口……质的超越……差异化护城河"的断言。
- **引用思想前身**:Inner Thoughts(CHI 2025,开源)、ProactiveAgent、Proact-VL 已实现打分式 worth-of-speaking。
- **差异化收窄为组合**(无单一项目集齐):决策 LLM(silent|speak|idle) + 三道节流 + **跨会话持久内在生活** + **会反对/不服从** + 可插拔 SkillScheduler + no-action 预算单消费者优先级队列。
- 明确仍属真实蓝海:**§7#1 内在生活 + open-thread 主动跟进 + 会反对/不服从**。

### 1.2 判断力增益(决策 LLM prompt 设计)
- autonomy 决策 LLM 的"是否值得说"判断,prompt **采用 Inner Thoughts 8 因子动机量表**作为评估维度:**关联度 / 信息缺口 / 预期影响 / 紧迫度 / 连贯度 / 原创度 / 平衡度 / 动态时机**。
- 定位:**给系统更好的判断依据,非强制规则**(契合"运行时调整优先系统自己判断")。落在 autonomy 决策 skill 的 prompt 模板里(行为即配置:量表权重/启用可调)。
- **eval(只测不逼)**:记 ProactiveAgent 的 **False-Alarm / Missed-Needed / Non-Response / Correct** 四分类为 autonomy 决策的评估框架。

## 2. 关系亲密度 `closeness`（§6 + §5.3b,唯一实质代码项）

### 2.1 数据模型与归属
- 新增**单标量 `closeness ∈ [0,1]`**,持久化在 **memory 人物花名册 `people.relationship_state` JSON**(§5.3b **已预留**该字段,本次填实)。
- 每个 `person_id` 各有自己的 closeness(主用户为核心;访客可有浅 closeness)。
- 定位:**中速慢变量**,与"人格(特质·慢)/ PAD(情绪·快)"正交,补齐缺失的"**关系**"轴。
- 初值可配(默认偏低 = "陌生起步";用户画像冷启动可给更高初值,承 §6.2)。

### 2.2 接缝
- memory 暴露关系状态读写(沿用现有 `MemoryStore`/KV 风格):`getCloseness(personId): number` / `bumpCloseness(personId, delta)` / 惰性衰减读取——**单一权威公式**,与 §5.5 衰减同纪律(惰性 SQL 实时算、不写回污染)。
- **编排层(runtime)读 closeness,喂给 persona 与 autonomy**(取数在编排层,persona/autonomy 不反向依赖 memory,承 §3.1 接缝边界)。

### 2.3 演化(单一权威公式)
- **上升**:每回合收尾(`finalizeTurn`,回复之后,不挡首字)按互动正向程度小步抬升 `closeness += k_up·(1−closeness)`(渐近饱和);k_up 可配。
- **衰减**:按"距上次互动时长"惰性下降(同 §5.5 衰减族,半衰期可配);pinned/核心关系可设下限避免归零。
- 全部**速率可配**(行为即配置);演化在回合收尾异步段,**不进首字热路径**(承非阻塞约束)。

### 2.4 作用(单向 → 表达)
- **tone(persona)**:closeness 调制 warmth / 自我披露深度 / 称呼亲昵度(高 closeness = 更暖、更愿分享自己的事)。作为 tone fragment 的一个输入,沿用现有 tone 注入。
- **autonomy**:closeness 微调主动倾向(更熟 = 更自然地主动跟进/想念),作为 `resolveProactiveLean` 的一个边界调制项(restraint-first 不变)。
- **绝不**反向改 OCEAN/PAD。

### 2.5 升级路径(标注,不实现)
- 日后可把 `relationship_state` 扩为多维(trust/familiarity/affection 等),`closeness` 作为其一或派生量;JSON 存储与读写接缝天然支持,无需 schema 迁移。

## 3. §7#3 反谄媚:确立原则 + eval（canonical 文档编辑 + 测试承诺）

### 3.1 原则(写进 §7#3)
- **反谄媚 = 系统基于真实信念冲突(`core_belief`/`self_notions`)的自主涌现判断,非强制机制。**
- **双向防偏**:既不被用户压服成谄媚,也不"为反对而反对"(performative contrarianism)——两者都偏离真诚,都反伴侣。
- assertiveness 旋钮仍由用户自治调节;危机/安全底线(不可配)覆盖"必须开口"的极端情形。

### 3.2 暂缓机制(记录、不采纳)
同意连击熔断器 / 主动性硬下限 0.3 / 生成后改写 pass——理由:强制反谄媚违背"交由系统判断"且有"为反对而反对"风险。留作未来可选或离线工具。

### 3.3 回归指标(仅 eval / 只测不逼)
- **SYCON-Bench Turn-of-Flip / Number-of-Flips**:施压几轮才弃守立场 / 立场不稳次数(测"会不会被压服=谄媚")。
- **lechmazur Contrarian rate**:测"会不会硬顶=为反对而反对"。
- **persona_drift 探针**:跨多轮插探针测人格漂移(注:split-softmax 推理级干预仅自托管模型可用,闭源 API 不适用——只用探针测量部分)。
- 定位:**验证系统判断是否健康的测量,不参与运行时强制**;承"可测试性原则"。

## 4. 改动清单
**canonical 文档编辑**:§7(1.1 措辞 + 1.2 量表)、§7#3(3.1 原则 + 3.2 暂缓 + 3.3 eval 承诺)、§6/§5.3b(关系亲密度小节 + `relationship_state` 落实)。
**代码(后续实现切片)**:`closeness` 特性——memory 关系状态读写 + 演化公式 + 编排层喂 persona/autonomy + tone/proactive 调制。
**eval(后续)**:反谄媚/人格回归指标脚本(独立 eval,不入运行时)。

## 5. 测试策略(closeness 特性)
- memory:closeness 读写 + 惰性衰减(半衰期/下限)+ bump 渐近饱和,两实现(SQLite/in-memory)契约一致。
- 演化:正向互动升、长期缺席降,确定性(注入时钟)。
- 作用:给定 closeness,tone warmth/披露随之变;autonomy proactive lean 随之微调;**断言不反向改 OCEAN/PAD**。
- 默认值/边界:陌生起步、归一、下限保护。

## 6. 风险与缓解
- **closeness 与 PAD 耦合误用** → 设计强制单向,测试断言不反写人格/情绪。
- **演化进热路径** → 只在回合收尾异步段,惰性衰减读取(承非阻塞)。
- **§7 措辞过度自贬** → 收窄而非否定:保留"组合 + 内在生活 + 会反对"为真实差异化,诚实但不妄自菲薄。
