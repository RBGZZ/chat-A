## ADDED Requirements

### Requirement: PerceptionSource 感知源框架

系统 SHALL 提供统一 `PerceptionSource` 接口(`id` / `modality ∈ {heard,sighted,felt,temporal,system}` / `start(emit)` / `stop` / `health`),每个源自管采集并发出**结构化** `raw:<modality>:<kind>` 事件(不过早描述化)。

#### Scenario: 源注册并启动后发出结构化 raw 事件
- **WHEN** 一个 PerceptionSource 被启动且其底层有输入(如时钟到点)
- **THEN** 该源经 `emit` 发出 `raw:<modality>:<kind>` 结构化事件,携带原始数据而非自然语言描述

#### Scenario: 源健康可探测、可停止
- **WHEN** 调用源的 `health()` 与 `stop()`
- **THEN** `health()` 返回源的健康状态;`stop()` 后该源不再发出事件

### Requirement: 三层去抖 → signal

系统 SHALL 经三层去抖把 raw 事件归一为 `signal:*`:源内边沿 latch → 滑窗 detector(纯函数,阈值走配置)→ 0.3s 聚合窗(合并多源),最终 fire 带 `description`/`metadata`/`confidence` 的 `signal:*` 事件。

#### Scenario: 多源抖动被聚合窗合并
- **WHEN** 0.3s 聚合窗内多个源/多次 raw 事件触发
- **THEN** 系统合并为单个(或有限个)`signal:*` 事件,避免"七嘴八舌"

#### Scenario: detector 是可测纯函数
- **WHEN** 以固定输入序列调用滑窗 detector
- **THEN** 输出确定(同输入同输出),阈值取自配置,可写 golden test

### Requirement: 内置感知源(MVP)

系统 SHALL 内置 `system.tick` 时钟心跳源与系统通知源,并为麦克风源(来自语音管线)留接入点。

#### Scenario: 时钟心跳驱动时间感知
- **WHEN** `system.tick` 源按配置周期触发
- **THEN** 发出 `temporal`/`system` 模态事件,供主动性/作息感知消费(经总线,不直接调 cognition)

### Requirement: 感知只采集不决策

感知子系统 SHALL 仅经 A 层模块总线发布 `signal:*` 事件,不直接调用 cognition/runtime,也不决定是否响应。

#### Scenario: 信号经总线单向发布
- **WHEN** 一个 `signal:*` 生成
- **THEN** 它被发布到 A 层总线(带 correlationId)供订阅者消费,感知模块自身不做"是否开口"的决策
