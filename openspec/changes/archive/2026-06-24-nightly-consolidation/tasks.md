## 1. 巩固编排器(触发节奏)

- [x] 1.1 `shouldConsolidate(trigger, state, clock)` 纯函数判定(会话结束 / 距上次≥1 天 / 轮数≥N),可注入时钟、可测
- [x] 1.2 `runConsolidation()` 后台 async + 幂等(`kv_state` 存在性检查,沿用 reflector 模式);失败仅告警(§3.2)
- [x] 1.3 触发阈值全配置化(config.ts;每日/每 N 轮可调);计时驱动留接缝(cli/autonomy/未来 cron 调用,本 change 不起守护进程)

## 2. 离线双 Pass 调和(§5.8)

- [x] 2.1 `sqlite-store` 增写接口:`updateMemory` / `markDiscarded`(事务内;core/pinned 永不删改)
- [x] 2.2 Pass1 提取候选(近期记忆);Pass2 对标既有 → diff `{add/update/delete/discard}`
- [x] 2.3 喂 LLM 用**临时整数 ID**(`[1][2]…`),返回 diff 引用整数 → 代码回映真 UUID 落库(抗幻觉)
- [x] 2.4 应用 diff:add 走既有 ADD;update 改写;delete→**保守标记 discard/加速衰减**(默认不物理删)
- [x] 2.5 复用现有 LLM 端口(reflector 模式),注入可测

## 3. 惊奇门控编码(§5.10 B2①,Nemori)

- [x] 3.1 predict-calibrate:由已有语义记忆预测本情景 → 对比原文取 prediction gap
- [x] 3.2 只把 gap 蒸馏入语义(放夜间 dream pass,有 LLM 预算);与热路径去重并存
- [x] 3.3 惊奇评估失败 → 退回"不门控照常蒸馏"(优雅降级)

## 4. 读写分离 / 整块重写(§5.10 B2②,Letta)

- [x] 4.1 夜间对某主题/某日重生成 clean summary 覆盖(整块重写),而非外科打补丁
- [x] 4.2 主体活动时只读;重写仅在巩固后台进行

## 5. 可回放(§8.1)

- [x] 5.1 巩固 diff / 惊奇 gap / discard 理由落 SQLite 决策 trace(可重建"为什么改/删")

## 6. 测试(注入 fake LLM,确定性,不触网)

- [x] 6.1 触发判定:三类 trigger 的 shouldConsolidate 边界;幂等跳过;失败仅告警
- [x] 6.2 双 Pass 调和:矛盾→update/discard;临时整数 ID 回映;**delete 保守(discard 非物删)+ core/pinned 豁免**
- [x] 6.3 惊奇门控:只蒸馏 gap;门控失败降级
- [x] 6.4 整块重写覆盖;可回放 trace 落库
- [x] 6.5 **回归(硬线)**:同步 `recall()`/`recallHybrid()` 热路径 + 既有去重/衰减行为逐字不变

## 7. 收尾

- [x] 7.1 worktree 根 `pnpm -r typecheck` 全绿
- [x] 7.2 worktree 根 `npx vitest run` 全绿(新增 + 回归)
- [x] 7.3 自检 §5.8 避坑(全后台、LLM 不在热路径决定 update/delete、单一权威衰减公式、delete 保守、临时整数 ID 抗幻觉)、§8.1 可回放;commit 到 worktree 分支(中文),不 push、不动 master
- [x] 7.4 简报注明:计时驱动(每日/每 N 轮)为接缝,需调用方接;Graphiti LSH 前置(B2③)留后续;物理删为极保守可选未默认
