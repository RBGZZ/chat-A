## Why

权威设计 §5.1 的「巩固流水线」(像睡眠一样固化记忆)是认知记忆架构的核心一环,但当前只实现了**会话级 Reflection**(`LlmReflector`:会话结束蒸馏 highlights + 自传 diary,幂等)。设计 §5.8/§5.10 B2 要求的**夜间巩固**仍缺:
- **离线双 Pass 调和**(§5.1/§5.8):提取→对标既有→diff `{add/update/delete/discard}` + 衰减遗忘——目前热路径只有 ADD+去重(SimHash/LSH),矛盾消解(update/delete)完全没有。
- **惊奇门控编码**(§5.9 缺口 2 / §5.10 B2①):用 Nemori predict-calibrate"只记住预料之外的"替/补机械的 SimHash 去重。
- **触发节奏**(§5.1):现仅会话结束;缺每日 / 每 N 轮的周期触发编排。

本变更补齐夜间巩固流水线,让记忆从"只增不理"进化到"会整理、会遗忘、只牢记意外",且**全程后台、低延迟预算、可回放**(§3.2/§8.1),严守 §5.8 避坑(不前台同步、不 LLM 误删、单一权威公式)。

## What Changes

- **巩固编排器**(触发节奏):统一调度 会话结束 / 每日 / 每 N 轮 三类触发,后台异步、幂等(沿用 `diary_{sessionId}` 式存在性检查),全部不挡热路径。
- **离线双 Pass 调和**(§5.8):Pass1 从近期记忆提取候选;Pass2 对标既有记忆产 diff `{add/update/delete/discard}`;**用临时整数 ID 而非真 UUID 喂 LLM 抗幻觉**(mem0 教训),回映后落库;**delete 保守**(标记 discard/加速衰减,不轻易物理删——长期伴侣价值在累积)。
- **惊奇门控编码**(§5.10 B2①):夜间 dream pass 用 predict-calibrate——由已有语义记忆预测本情景 → 对比原文取 prediction gap → **只蒸馏 gap 入语义**。
- **读写分离/整块重写**(§5.10 B2②,Letta 式):夜间重生成 clean summary,不在主体活动时外科打补丁。

## Capabilities

### New Capabilities
- `memory-consolidation`: 夜间/周期巩固流水线——触发编排 + 离线双 Pass 调和(update/delete/discard)+ 惊奇门控编码 + 整块重写,全后台、可回放。

### Modified Capabilities
<!-- 热路径 ADD+去重、recall、衰减公式均不变;巩固是新增的后台层,不改既有同步召回行为。 -->

## Impact

- **改动**:`packages/memory`(新增 consolidation 模块 + orchestrator;`sqlite-store` 增 update/discard 写接口;复用 `reflector` 的 LLM 端口)。
- **依赖**:复用现有 LLM 端口(测试用 fake/确定性),不引新依赖。
- **不动**:`runtime`/`persona`/`interaction`/`gateway`;memory 的同步 `recall()`/`recallHybrid()` 热路径行为逐字不变。
- **降级/默认**(§3.2):巩固失败仅告警、不影响主对话;全部后台 fire-and-forget;触发可配(行为即配置)。
- **避坑**(§5.8):不前台同步巩固、不让 LLM 热路径决定 update/delete、单一权威衰减公式、delete 保守。
- **并行安全**:全在 `packages/memory`,与其它三个并行 change 无文件重叠。
