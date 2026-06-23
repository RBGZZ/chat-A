## Context

canonical §7 把 autonomy 的工程化拆成四块可独立验收的确定性内核:技能调度、优先级事件队列、输出仲裁、预算节流。本切片只造这四块的**地基引擎**,**standalone**——用 fake 时钟/事件源驱动,不接 Conversation/总线/runtime。设计目标:每块都是可写 golden 的纯内核,接缝清晰,后续切片只"接线"不改内核。

## Goals / Non-Goals

- Goals:四块内核确定性可测(注入时钟/事件源)、接缝化(BaseSkill/EventSource/Clock 依赖倒置)、行为即配置(预算/优先级/enabled 外置)、优雅降级(技能异常隔离)。
- Non-Goals:接线到 runtime/总线/cognition;LLM 决策;OTel/SQLite;Neuro 专有 force/priority(🅽)。

## Decisions

### 1. 事件分级:三级常量 + 数值序

- `EventPriority = URGENT | PERCEPTION | LOWEST`,映射到数值(URGENT 最大)。**单消费者**每次出队取数值最高者;**同级 FIFO**(用入队单调序号 `seq` 决定,确定性)。
- 为什么不用 `setInterval`:认知由"事件到达 / 注入 tick"推动,可在测试里完全确定地推进——避开 Neuro `Signals` 全局可变状态(§4.2 ⚠️)。
- `LOWEST` 专留给 no-action 合成的"再想一次"事件,确保用户/感知事件永远优先被消费。

### 2. SkillScheduler:单循环 reconcile + 现读 enabled + inflight 锁

- 每 tick 遍历已注册技能:**现读** `config.isEnabled(skillId)`(改配置下一 tick 生效)。
  - enabled 且未 started → `start()`(首次前 `initialize()` 恰一次);已 started 且仍 enabled → `tick()`。
  - 之前 started 但本 tick 变 disabled → `stop()`。
- **per-skill inflight 锁**:技能 `tick()` 返回 Promise,未结算前该技能的下一次 tick 跳过(不并发重入)。锁在结算后(无论 fulfilled/rejected)释放。
- **异常隔离**(优雅降级 §3.2):某技能钩子抛错 → 捕获 + 计数,不中断其它技能、不杀调度循环。
- `onConfigReload()`:配置热更钩子,scheduler 收到 reload 信号时对所有 started 技能广播(各自做幂等读取);**不强制重启**。

### 3. requestSpeak 仲裁:单一 is_speaking 硬闸 + 优先级抢占

- 入口 `arbitrate(request, state)` 纯函数 → `{ decision: 'speak'|'defer'|'drop', ... }`:
  - 空闲(`!is_speaking`)→ `speak`。
  - 忙(`is_speaking`)且来者优先级 **高于** 在说者 → `speak`(抢占,产出 `preempted` 标记交调用方做 abort 三件套,本期只给信号不真 abort)。
  - 忙且来者**可延续**(`deferrable`)→ `defer`(记 history 待续,resumeBuffer 留给后续切片续播)。
  - 否则 → `drop`。
- 硬闸是**单一** `is_speaking` 布尔(canonical 强调"单一硬闸"),仲裁器不自己维护播放状态——状态由调用方传入,保持纯函数可测。

### 4. no-action 预算:扣减 + 合成事件 + 外部重置

- `BudgetState{ remaining }`,默认 `maxNoActionRetries=3`(外置 config)。
- 一轮(一次队列消费 + 技能处理)无任何产出动作:
  - `remaining > 0` → 扣 1,产出一个 `LOWEST` 的合成"再想一次"事件入队(让引擎下轮再尝试)。
  - `remaining == 0` → 不再合成(停止空转),引擎进入 idle。
- 任何外部信号(`resetBudget()`,如用户开口)→ `remaining` 复位 + **丢弃队列中所有 LOWEST 合成事件**(丢弃排队的自言自语)。

## Risks / Trade-offs

- 本期"抢占"只产出 `preempted` 信号、不真做 abort 三件套(那在 runtime 层)——接线切片须消费此信号。已在类型上留位。
- requestSpeak 纯函数化要求调用方维护 `is_speaking`;好处是内核零状态、golden 友好。

## Migration Plan

无数据迁移(standalone 纯内核,无持久化)。后续接线切片把 EventSource 接到 LightVoiceBus、Clock 接到真实时钟、requestSpeak 信号接到 runtime abort。

## Open Questions

- resumeBuffer 续播的具体续接语义(backchannel "继续/嗯")留接线切片定;本期只保留 defer 决策与占位字段。
