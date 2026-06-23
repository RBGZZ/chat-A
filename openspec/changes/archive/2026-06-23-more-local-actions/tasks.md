## 1. calculate 动作

- [ ] 1.1 `src/actions/calculate.ts`:`createCalculateAction()` 返回 `Action`;入参两形态 `{expression}` 或 `{a,op,b}`;inputSchema 用 `oneOf` 描述(required 留空,真校验在 perform)
- [ ] 1.2 自写最小四则解析器(递归下降:数字/小数/负号/`+ - * /`/括号/空白),**不用 eval**;除零 → `isError`;非法 → `isError`
- [ ] 1.3 结构化形态直接算,op 非法 → `isError`

## 2. set_reminder 动作(内存版)

- [ ] 2.1 `src/actions/set-reminder.ts`:`ReminderStore` 接缝(`add`/`list`)+ `InMemoryReminderStore` 默认实现;`StoredReminder` 含 `text`/`atIso?`,预留 `onDue?` 接口(本期不接调度)
- [ ] 2.2 `createSetReminderAction(store)` 返回 `Action`;入参 `{text, atIso?}`;`atIso` 不可解析 → `isError`;存入 store
- [ ] 2.3 导出 `listReminders(store)` 便于读取

## 3. unit_convert 动作

- [ ] 3.1 `src/actions/unit-convert.ts`:外置常量——`unit→dimension` 表 + 线性单位到基准系数表(长度/质量);温度(c/f/k)单独函数
- [ ] 3.2 `createUnitConvertAction()` 返回 `Action`;入参 `{value, from, to}`;未知单位/跨量纲 → `isError`

## 4. 装配

- [ ] 4.1 `buildDefaultRegistry({ now?, reminderStore? })` 注册 calculate/set_reminder/unit_convert;`set_reminder` 用注入或新建的 store
- [ ] 4.2 `src/index.ts` 导出三个新动作工厂 + ReminderStore 相关类型

## 5. 测试(每动作正常 + 容错)

- [ ] 5.1 calculate:`{expression}` 优先级/括号正常、`{a,op,b}` 正常、除零→isError、非法表达式→isError、op 非法→isError
- [ ] 5.2 set_reminder:注入 store→add 后 list 可读、缺 text→isError(轻量校验)、atIso 不可解析→isError
- [ ] 5.3 unit_convert:长度/质量/温度各一正常、未知单位→isError、跨量纲→isError
- [ ] 5.4 buildDefaultRegistry:size/`toolDefs()` 含四个动作名

## 6. 收尾

- [ ] 6.1 worktree 根 `pnpm -r typecheck` 全绿
- [ ] 6.2 `npx vitest run` 全绿
