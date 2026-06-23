## 1. list_reminders 动作

- [ ] 1.1 `src/actions/list-reminders.ts`:`createListRemindersAction(store: ReminderStore): Action`;无入参;`capability:'time'`
- [ ] 1.2 `perform`:读 `store.list()`;空 → 可读"没有提醒";非空 → 逐条列出(序号 + text + 可选 atIso),纯读无副作用

## 2. recall_fact 动作(注入回调,不依赖 memory)

- [ ] 2.1 `src/actions/recall-fact.ts`:`FactLookup = (query:string)=>string|undefined` 接缝;`createRecallFactAction(lookup?: FactLookup): Action`;缺省 lookup 恒返回 undefined;**不声明 capability**;**不 import memory**
- [ ] 2.2 `perform`:入参 `{query}`;query 非字符串/空 → isError;调 lookup,命中 → 回结果,未命中(undefined/空) → 正常"想不起"(非 isError)

## 3. countdown 动作

- [ ] 3.1 `src/actions/countdown.ts`:`createCountdownAction(now:()=>Date=()=>new Date()): Action`;入参 `{atIso}`;`capability:'time'`
- [ ] 3.2 `perform`:atIso 非字符串/不可解析 → isError(不抛);算 target-now,正 → "还有 d/h/m";负/0 → "已过去 …";整数毫秒拆分(确定性)

## 4. 既有动作能力标注

- [ ] 4.1 `current-time.ts`:加 `capability:'time'`(其它行为不变)
- [ ] 4.2 `set-reminder.ts`:加 `capability:'time'`(其它行为不变)

## 5. 装配

- [ ] 5.1 `buildDefaultRegistry({ now?, reminderStore?, factLookup? })` 追加注册 list_reminders/recall_fact/countdown;list_reminders 与 set_reminder 复用同一 reminderStore;countdown 复用 now
- [ ] 5.2 `src/index.ts` 导出三个新动作工厂 + `FactLookup` 类型

## 6. 测试(每动作正常 + 容错;能力标注 + 能力门过滤;注入确定性)

- [ ] 6.1 list_reminders:共享 store(set_reminder 写入后能读到)、空 store 可读说明、capability==='time'
- [ ] 6.2 recall_fact:注入命中→回结果(非 error)、未命中(undefined)→正常想不起(非 error)、缺省 lookup→暂不可用(非 error)、缺/空 query→isError、capability===undefined
- [ ] 6.3 countdown:注入时钟未来 atIso→剩余时长(非 error)、过去 atIso→已过去(非 error)、不可解析→isError、capability==='time'、同时钟确定性
- [ ] 6.4 能力标注:四个时间域动作 capability==='time';四个纯计算动作 capability===undefined
- [ ] 6.5 buildDefaultRegistry:size===8;toolDefs() 含 8 名;空能力集 new Set() 下仅纯计算动作(能力门过滤生效)

## 7. 收尾

- [ ] 7.1 worktree 根 `pnpm -r typecheck` 全绿
- [ ] 7.2 `npx vitest run` 全绿
