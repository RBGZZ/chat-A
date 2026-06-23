## ADDED Requirements

### Requirement: 关系亲密度 closeness 状态与演化(单一权威公式)

人物花名册 SHALL 为每个 `person_id` 维护**关系亲密度** `closeness ∈ [0,1]`，存于 `people.relationship_state`(JSON)的子字段。closeness 是中速慢变量(承 §6.1b / §5.3b)，演化两条且 MUST 用**单一权威公式**(承 §5.5 同纪律，不得引入后台与读取两套漂移)：

- **长期缺席衰减**：读取 closeness MUST 按距上次互动时长**惰性实时计算** `c·0.5^(days/H)`，其中 `days = max(0, (now − updatedAt)/一天毫秒)`(时钟回拨/未来时间不放大)，`H` 为半衰期且 MUST 外置(无 magic number，默认 30 天)。衰减 MUST **读不写回**(不污染存储、不复利漂移，承 §5.5)。衰减/抬升结果 MUST 夹到 `[closenessFloor, 1]`(下限外置，保护核心关系不归零、上限封顶)。
- **积极互动缓升**：抬升 MUST 按 `c' = c + k·clamp(valencePos,0,1)·(1−c)` 渐近饱和(单调趋近 1 不越界)，`k` 为抬升系数且 MUST 外置(默认 0.1)。`valencePos ≤ 0` 时 MUST 只刷新衰减基线时间戳(等价 `c'=c`，不升)。

衰减与抬升的纯函数 MUST 被 SQLite 与 InMemory 两实现**共用**(单一权威，杜绝两后端各写一遍漂移，承 §3.2)。

`MemoryStore` SHALL 暴露：`getCloseness(personId)`(以"现在"读，惰性衰减)、`getClosenessAt(personId, atMs)`(可注入时刻，供确定性测试与编排层固定时刻演化)、`bumpCloseness(personId, valencePos, atMs)`(取衰减后当前值→渐近抬升→写回 `relationship_state`，返回新值)。对**未知 person_id** MUST 幂等不抛(写命中 0 行、读返回配置初值，承 §3.2)。写入失败 MUST 优雅降级(不抛、不拖垮调用方)。

#### Scenario: 默认初值(陌生起步)

- **WHEN** 对一个 `relationship_state` 无 closeness 记录的 person 读取 closeness
- **THEN** 返回配置的 `initialCloseness`(陌生起步)，且读取不写回任何记录

#### Scenario: 积极互动后缓升且渐近饱和

- **WHEN** 对同一 person 连续两次以满正向 valence 调用 `bumpCloseness`
- **THEN** 第一次较初值上升、第二次再上升，但第二次增量更小(渐近趋近 1，单调不越界)

#### Scenario: 长期缺席后惰性衰减

- **WHEN** 一个 person 的 closeness 在某时刻被抬升，之后经过一个半衰期再读取(`getClosenessAt`)
- **THEN** 读到的值约为抬升后值的一半(`0.5^(days/H)`)，且该衰减仅在读取时算、未写回存储

#### Scenario: 非正向 valence 不升只刷新基线

- **WHEN** 以 `valencePos ≤ 0` 调用 `bumpCloseness`
- **THEN** closeness 数值不上升(等价当前衰减后值)，仅刷新衰减基线时间戳

#### Scenario: 未知 person 幂等不抛

- **WHEN** 对花名册中不存在的 person_id 调用 `bumpCloseness` 或读取 closeness
- **THEN** 不抛异常(写命中 0 行、读返回配置初值)

#### Scenario: 半衰期/抬升系数/初值/下限可配置

- **WHEN** 通过配置指定半衰期 H、抬升系数 k、初值或下限
- **THEN** 衰减/抬升/默认/夹取按所配参数计算，而非内置默认值

### Requirement: closeness 存储零数据丢失

引入 closeness 子字段 MUST NOT 丢失任何存量数据(承 §3.2 数据迁移纪律)。closeness 存于 v3 已建的可空列 `people.relationship_state`(JSON)中，旧库无 closeness 记录的 person MUST 在**读取路径惰性兜底**配置初值(无需 backfill、零数据丢失)；`relationship_state` 解析失败 MUST 同样降级为配置初值而非损坏数据。

#### Scenario: 旧库 person 无 closeness 记录仍可读

- **WHEN** 打开一个 `relationship_state` 为空(或无 closeness 子字段)的旧库并读取某 person 的 closeness
- **THEN** 返回配置初值，原有花名册数据(name/status 等)无任何丢失，后续 `bumpCloseness` 可正常写入
