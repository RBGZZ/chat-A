## Context

`packages/memory` 现状:`sqlite-store.ts`(真相源 schema v8、同步 `recall()`/`recallHybrid()`、PPR 联想扩散、ADD 写路径 + SimHash/LSH 去重、memory_kind ∈ {episodic,semantic,core}、衰减惰性实时算)、`reflector.ts`(`LlmReflector`:会话结束读消息 → LLM 蒸馏 highlights + 自传 diary → 写回 shared/agent 主语 → 幂等标记 `kv_state`)。

缺口(§5.1/§5.8/§5.10 B2):无离线双 Pass 调和(update/delete/discard)、无惊奇门控编码、触发仅会话结束。设计硬约束:**全后台**(前台同步巩固会阻塞响应,Letta 教训)、**LLM 不在热路径决定 update/delete**(mem0 退回 ADD-only 教训)、**单一权威衰减公式**、**delete 保守**、**可回放**(§8.1)。

## Goals / Non-Goals

**Goals:**
- 巩固编排器:统一三类触发(会话结束 / 每日 / 每 N 轮),后台异步 + 幂等(沿用存在性检查),不挡热路径。
- 离线双 Pass 调和:提取候选 → 对标既有 → diff `{add/update/delete/discard}`;喂 LLM 时用**临时整数 ID**(回映真 UUID 落库)抗幻觉;delete 保守(标记 discard / 加速衰减,默认不物理删)。
- 惊奇门控编码(Nemori predict-calibrate):由已有语义记忆预测本情景 → 对比原文取 prediction gap → 只蒸馏 gap 入语义。
- 读写分离 / 整块重写(Letta):夜间重生成 clean summary,不外科打补丁。
- 全部可测:LLM 端口注入 fake、确定性;调和 diff 应用、惊奇门控、幂等、delete 保守均写测试,不依赖真实 LLM。
- 可回放(§8.1):巩固决策(diff、惊奇 gap、删除/discard 理由)落 SQLite 决策 trace。

**Non-Goals:**
- 改动热路径 ADD+去重 / 同步 recall / 衰减公式(本 change 只加后台层)。
- 物理删除记忆为默认行为(保守:标记 discard/衰减;物理删仅极保守、可选)。
- Graphiti LSH 去重前置(§5.10 B2③)——属 ADD 热路径优化,本 change 聚焦夜间,留后续(或独立小 change)。
- 真实定时调度器/cron 守护进程——本 change 提供可被 runtime/autonomy/cli 调用的"巩固入口"+ 触发判定逻辑;实际计时驱动由调用方接(留接缝)。

## Decisions

1. **巩固编排器 = 纯逻辑触发判定 + 可注入时钟**:`shouldConsolidate(trigger, state, clock)` 纯函数判定(会话结束 / 距上次≥1 天 / 轮数≥N);执行 `runConsolidation()` 后台 async;幂等用 `kv_state`(沿用 reflector 模式)。计时由调用方驱动(cli/autonomy/未来 cron),本 change 不起守护进程。
2. **双 Pass 调和喂 LLM 用临时整数 ID**(mem0 `main.py:815-820` 抗幻觉):Pass2 把候选 + 待对标既有记忆以 `[1] [2] …` 临时整数列表喂 LLM,LLM 返回 diff 引用整数 ID,代码回映真 UUID 落库——LLM 不见真 UUID,避免幻觉乱引。
3. **delete 保守 = 默认 discard/衰减**:diff 的 `delete` 不物理删,而是标记 `discard`(或加速衰减),核心/pinned 永不参与(§5.4/§5.9 边界);物理删仅作极保守可选项。`sqlite-store` 增 `updateMemory`/`markDiscarded` 写接口(事务内)。
4. **惊奇门控编码独立于去重**:predict-calibrate 用已有语义记忆预测本情景,只把 prediction gap 蒸馏入语义(放夜间 dream pass,有 LLM 预算);与热路径 SimHash/LSH 去重并存(去重防膨胀、惊奇定"值不值得记牢")。
5. **整块重写而非打补丁**(Letta):夜间对某主题/某日重生成 clean summary 覆盖,而非增量改写散条——主体活动时只读、夜间重写。
6. **全后台 + 失败仅告警**(§3.2):巩固 fire-and-forget,异常隔离不影响主对话;低延迟预算(夜间/空闲跑)。
7. **可回放**(§8.1):每次巩固的 diff、惊奇 gap、discard 理由落 SQLite 决策 trace,可重建"为什么改/删了这条记忆"。

## Risks / Trade-offs

- **LLM 误删/误改**:用临时整数 ID 抗幻觉 + delete 保守(discard 非物删)+ 核心 pinned 豁免 + 可回放兜底;宁可漏改不可错删(承 §5.8)。
- **触发节奏调参**:每日/每 N 轮阈值全配置化;真实节奏需运行后调(§11 待决:巩固触发节奏)。
- **后台与 recall 并发**:巩固写与同步 recall 读并发——用事务 + 单一真相源保证一致;recall 行为不变(读已提交)。
- **惊奇门控的 LLM 成本**:放夜间/空闲、批处理摊销;失败退回"不门控、照常蒸馏"(优雅降级)。
- **计时驱动留接缝**:本 change 不起 cron;若调用方暂未接,巩固仅在会话结束触发(等同现状 + 新调和能力),每日/每 N 轮待接——简报需说明。
