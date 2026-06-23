# autonomy Specification

## Purpose
TBD - created by archiving change autonomy-engine. Update Purpose after archive.
## Requirements
### Requirement: 单消费者优先级事件队列

系统 SHALL 提供一个单消费者优先级事件队列,事件分级为 `URGENT`/`PERCEPTION`/`LOWEST`(优先级 URGENT 最高)。出队 SHALL 取当前最高优先级事件;同优先级 SHALL 按入队顺序 FIFO。队列 MUST NOT 依赖 `setInterval`/壁钟驱动认知——由注入的事件源/tick 推动(确定性可测)。空队列出队 SHALL 返回"无事件"而非抛错。

#### Scenario: 高优先级先于低优先级出队

- **WHEN** 依次入队 `LOWEST`、`URGENT`、`PERCEPTION` 三个事件,然后连续出队三次
- **THEN** 出队顺序为 `URGENT`、`PERCEPTION`、`LOWEST`

#### Scenario: 同优先级按入队顺序 FIFO

- **WHEN** 依次入队三个 `PERCEPTION` 事件 A、B、C,然后连续出队
- **THEN** 出队顺序为 A、B、C

#### Scenario: 空队列出队不抛错

- **WHEN** 对空队列调用出队
- **THEN** 返回表示"无事件"的结果(如 `undefined`),不抛异常

### Requirement: SkillScheduler 单循环 reconcile 与 enabled 热读

系统 SHALL 提供 `SkillScheduler`,单循环 reconcile 多个已注册后台技能。每 tick SHALL **现读** config 的 `enabled`(改配置在下一 tick 生效,无需重启)。技能首次被启用时 SHALL 先调 `initialize()`(恰一次)再 `start()`;持续启用时每 tick 调 `tick()`;由启用转为禁用时 SHALL 调 `stop()`。

#### Scenario: enabled 热读在下一 tick 生效

- **WHEN** 技能初始 disabled,运行一 tick(技能不应启动),随后把 config 改为 enabled,再运行一 tick
- **THEN** 第一 tick 技能未 `start`;第二 tick 技能被 `initialize`+`start`

#### Scenario: 禁用已启动技能触发 stop

- **WHEN** 技能 enabled 跑过若干 tick(已 started),随后 config 改为 disabled,再运行一 tick
- **THEN** 该 tick 调用技能 `stop()`,且不再调 `tick()`

#### Scenario: initialize 恰调用一次

- **WHEN** 技能保持 enabled 连续运行多 tick
- **THEN** `initialize` 全程只被调用一次,`tick` 每 tick 调用一次

### Requirement: per-skill inflight 锁

系统 SHALL 为每个技能维护 inflight 锁:某技能上一 tick 的处理(返回 Promise)尚未结算时,该技能的下一 tick SHALL 跳过(不并发重入)。锁 SHALL 在处理结算后释放,无论成功或失败。

#### Scenario: 未结算时跳过本 tick

- **WHEN** 技能 `tick()` 返回一个尚未 resolve 的 Promise,在其结算前再触发一 tick
- **THEN** 第二 tick 不再调用该技能的 `tick()`(被 inflight 锁跳过)

#### Scenario: 结算后恢复调度

- **WHEN** 上述 Promise 结算后再触发一 tick
- **THEN** 该 tick 正常调用技能 `tick()`(锁已释放)

### Requirement: 技能异常隔离(优雅降级)

调度循环 SHALL 隔离单个技能钩子抛出的异常:某技能 `tick`/`start`/`stop` 抛错 SHALL 被捕获,不中断其它技能、不终止调度循环;异常 SHOULD 被计数或上报以便追溯(§8.1)。

#### Scenario: 一个技能抛错不影响其它技能

- **WHEN** 注册技能 A(`tick` 抛错)与技能 B(正常),运行一 tick
- **THEN** 技能 B 的 `tick` 正常被调用;调度循环不抛出、可继续下一 tick

### Requirement: requestSpeak 输出仲裁器

系统 SHALL 提供统一的 `requestSpeak` 仲裁入口:所有技能"想说"都经此入口,依据单一 `is_speaking` 硬闸 + 请求优先级裁决为 `speak`/`defer`/`drop`。空闲时 SHALL 裁为 `speak`;忙且来者优先级高于在说者 SHALL 裁为 `speak` 并标记抢占(`preempted`,交调用方做 abort);忙且来者可延续(`deferrable`)SHALL 裁为 `defer`;否则 SHALL 裁为 `drop`。仲裁 SHALL 为纯函数(播放状态由入参提供,不在仲裁器内维护),以利确定性测试。

#### Scenario: 空闲直接放行

- **WHEN** `is_speaking=false` 时请求发言
- **THEN** 裁决为 `speak`

#### Scenario: 忙且更高优先级抢占

- **WHEN** `is_speaking=true`、在说者优先级 `PERCEPTION`,来者优先级 `URGENT`
- **THEN** 裁决为 `speak` 且带 `preempted` 抢占标记

#### Scenario: 忙且可延续则 defer

- **WHEN** `is_speaking=true`、来者优先级不高于在说者,但来者 `deferrable=true`
- **THEN** 裁决为 `defer`(记 history 待续)

#### Scenario: 忙且不可延续则丢弃

- **WHEN** `is_speaking=true`、来者优先级不高于在说者,且 `deferrable=false`
- **THEN** 裁决为 `drop`

### Requirement: no-action 预算节流

系统 SHALL 维护 no-action 预算(默认上限外置,默认 3):一轮处理无任何产出动作时,若预算剩余 `>0` SHALL 扣 1 并合成一个 `LOWEST` 优先级"再想一次"事件入队;剩余为 0 时 SHALL 停止合成(不空转)。外部信号 SHALL 能重置预算并丢弃队列中所有 `LOWEST` 合成事件。预算上限 SHALL 外置为配置(行为即配置,§3.2),不得硬编码 magic number。

#### Scenario: 无产出扣预算并合成再想一次事件

- **WHEN** 预算剩余 3、一轮处理无产出动作
- **THEN** 预算降为 2,且队列新增一个 `LOWEST` 的合成"再想一次"事件

#### Scenario: 预算耗尽停止合成

- **WHEN** 预算剩余 0、一轮处理无产出动作
- **THEN** 不再合成新事件(引擎进入 idle 不空转),预算保持 0

#### Scenario: 外部信号重置预算并清空自言自语

- **WHEN** 预算已被扣减且队列含若干 `LOWEST` 合成事件,此时收到外部重置信号
- **THEN** 预算复位到上限,且队列中所有 `LOWEST` 合成事件被丢弃(非 LOWEST 事件保留)

