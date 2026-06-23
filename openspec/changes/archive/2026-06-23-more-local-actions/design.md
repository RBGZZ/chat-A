# 设计:更多本地动作(§12.2)

## 范围与约束

- 只动 `packages/interaction/**`。新动作经既有 `ActionRegistry.toolDefs()` 自动喂给 `ToolCallingStrategy`,**不碰 runtime/cli/其它包**。
- 每个动作仍是既有 `Action` 接缝:`{ name, description, inputSchema(JSON schema), perform(input): Promise<ActionResult> }`。
- 容错由 `ActionRegistry.execute` 统一兜底:未知工具/轻量入参校验失败/`perform` 抛错 → `isError` 的 `ToolResult`,不抛。动作内部的"业务级失败"(除零、未知单位)主动返回 `{ isError: true }`。
- 副作用源可注入(确定性测试,§3.2):提醒存储可注入;`set_reminder` 的"当前时间"也走注入时钟以便确定性默认 `atIso`(本期不默认填,见下)。

## calculate

入参两形态(择一):
- `{ expression: string }`:如 `"3 + 4 * 2"`、`"(1+2)*3"`。
- `{ a: number, op: '+'|'-'|'*'|'/', b: number }`:结构化,无需解析。

实现:**不用 `eval`**。写一个最小递归下降解析器,仅识别:十进制数字(含小数/负号)、`+ - * /`、圆括号、空白。其它字符 → 解析失败 → `isError`。除以零 → `isError`("除数为零")。结果用 `Number`,IEEE754 即可。

inputSchema 用 `oneOf` 表达两形态;但既有轻量校验只看 `required`/`properties`,`oneOf` 不被它强约束——因此 `required` 留空,真正的"二选一"在 `perform` 里判定并对缺失/非法返回 `isError`(优雅降级,不抛)。

## set_reminder(内存版)

入参:`{ text: string, atIso?: string }`。`atIso` 为可选 ISO 时间串;给了就校验可解析(不可解析 → `isError`)。

存储:进程内 `ReminderStore` 接缝——`add(reminder): StoredReminder`、`list(): readonly StoredReminder[]`。默认实现 `InMemoryReminderStore`(数组)。`buildDefaultRegistry({ reminderStore })` 可注入同一实例,使 `listReminders()` 能读到所注册动作写入的提醒(确定性测试)。

到点回调:`StoredReminder` 预留可选 `onDue?` 字段 / store 预留 `onAdd` 钩子接口,但**本期不接任何调度器/定时器**——只入列。注释标注"调度接线待 runtime 调度器就绪"。

模块导出 `listReminders(store)` 便于读取(或经 store 实例 `.list()`)。

## unit_convert

入参:`{ value: number, from: string, to: string }`。固定换算表:同一量纲(长度/质量/温度)内换算;`from`/`to` 不同量纲或未知单位 → `isError`。

实现:
- 线性量纲(长度 m 基准、质量 g 基准)用"到基准的系数"表:`value_to = value * factor[from] / factor[to]`。
- 温度(c/f/k)非线性,单独函数处理(c↔f↔k)。
- 量纲归属用一张 `unit → dimension` 表;`from`/`to` 量纲不一致 → `isError`。

换算表/支持单位作为模块级常量(行为即配置,§3.2)。

## 测试要点(§3.2)

- calculate:`{expression}` 正常(含优先级/括号)、`{a,op,b}` 正常、除零 → isError、非法表达式 → isError、缺两形态必需字段 → isError。
- set_reminder:注入 store → add 后 `list()` 能读到、缺 `text` → isError(走轻量校验)、`atIso` 不可解析 → isError、注入 store 实例确定性。
- unit_convert:同量纲正常(长度/质量/温度各一)、未知单位 → isError、跨量纲 → isError。
- buildDefaultRegistry:size 含新动作、`toolDefs()` 形态含新动作名。
