## 1. 包脚手架(standalone)

- [ ] 1.1 `packages/autonomy/package.json`(`@chat-a/autonomy`,ESM,main/types 指向 src;`typecheck`/`test` 脚本)
- [ ] 1.2 `packages/autonomy/tsconfig.json`(extends ../../tsconfig.base.json,types:["node"],noEmit)
- [ ] 1.3 `src/index.ts` 汇出公共 API

## 2. 配置与公共类型(行为即配置,无 magic number)

- [ ] 2.1 `src/config.ts`:`AutonomyConfig`(`maxNoActionRetries` 默认 3、enabled 查询 `isEnabled(skillId)`)+ `DEFAULT_AUTONOMY_CONFIG` + `resolveAutonomyConfig(overrides)`
- [ ] 2.2 `src/types.ts`:`Clock` 接缝(注入时钟)、`EventPriority`(URGENT/PERCEPTION/LOWEST)+ 数值序、`AutonomyEvent`、`SpeakRequest`、仲裁结果类型

## 3. 优先级事件队列(确定性内核)

- [ ] 3.1 `src/priority-queue.ts`:单消费者优先级队列;高优先级先出、同级 FIFO(单调 seq);空出队返回 undefined
- [ ] 3.2 `dropWhere(predicate)` / 丢弃所有 LOWEST 合成事件的能力(供预算重置用)

## 4. SkillScheduler + BaseSkill 接缝

- [ ] 4.1 `src/skill.ts`:`BaseSkill` 接口(`id` + 生命周期 `initialize/start/stop/onConfigReload` + `tick`,均可选返回 Promise)
- [ ] 4.2 `src/scheduler.ts`:`SkillScheduler` 单循环 reconcile;现读 enabled(下一 tick 生效);initialize 恰一次;start/stop 生命周期;per-skill inflight 锁(未结算跳过、结算后释放);异常隔离 + 计数;`onConfigReload` 广播

## 5. requestSpeak 仲裁器(纯函数内核)

- [ ] 5.1 `src/arbiter.ts`:`arbitrate(request, state)` → speak/defer/drop;单一 is_speaking 硬闸;高优先级抢占带 preempted 标记;deferrable→defer;否则 drop

## 6. no-action 预算节流

- [ ] 6.1 `src/budget.ts`:`BudgetState` + `consumeOnNoAction`(扣 1 + 合成 LOWEST 事件 / 耗尽停)+ `resetBudget`(复位 + 丢弃 LOWEST 合成事件);上限来自 config

## 7. 测试(确定性 golden;fake 时钟/事件源)

- [ ] 7.1 priority-queue:高低优先级出队序、同级 FIFO、空出队 undefined
- [ ] 7.2 scheduler:enabled 热读(下一 tick 生效)、disable→stop、initialize 恰一次、inflight 锁(未结算跳过/结算后恢复)、异常隔离
- [ ] 7.3 arbiter:空闲 speak、忙+高优先级抢占(preempted)、忙+deferrable defer、忙+不可延续 drop
- [ ] 7.4 budget:无产出扣减+合成事件、耗尽停止合成、外部重置复位+清空 LOWEST

## 8. 收尾

- [ ] 8.1 worktree 根 `pnpm install`(链接新包)
- [ ] 8.2 `pnpm -r typecheck` 全绿
- [ ] 8.3 `npx vitest run` 全绿
