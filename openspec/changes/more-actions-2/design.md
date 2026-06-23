# 设计:更多本地动作 + 能力标注(§12.2)

## 范围与约束

- 只动 `packages/interaction/**`(+ 本 change 目录)。新动作经既有 `ActionRegistry.toolDefs()` 自动喂给 `ToolCallingStrategy`,**不碰 runtime/cli/其它包**;**绝不 import memory/runtime**。
- 每个动作仍是既有 `Action` 接缝:`{ name, description, inputSchema, capability?, perform(input): Promise<ActionResult> }`。
- 容错由 `ActionRegistry.execute` 统一兜底:未知工具/轻量入参校验失败/`perform` 抛错 → `isError` 的 `ToolResult`,不抛。动作内部"业务级失败"(不可解析时间)主动返回 `{ isError: true }`;"没查到事实"属正常结果(非 error)。
- 副作用源可注入(确定性测试,§3.2):`list_reminders` 共享注入的 `ReminderStore`;`countdown` 用注入时钟;`recall_fact` 用注入查询回调。

## 能力标注策略(§12.2)

- `capability` 缺省 = 无需任何能力、始终可用。仅给**确需设备/环境能力**的动作标注。
- 时间域 `'time'`:`current_time`(读现在)、`set_reminder`(记带时间的提醒)、`list_reminders`(读提醒)、`countdown`(读现在算剩余)。
- 不标(纯计算,任何设备可用):`calculate`、`unit_convert`、`date_diff`(给定两端,不读"现在")、`recall_fact`(纯本地查询回调)。
- 标注为纯加法:`buildDefaultRegistry()` 默认不配能力集,`#isAuthorized` 在能力集 `undefined` 时全授权,故 `toolDefs()`/`execute()` 行为与标注前**逐字一致**;仅当调用方显式 `withCapabilities()`/构造传集合时才据此过滤。

## list_reminders

- 入参:无(`{ type:'object', properties:{}, required:[] }`)。
- `createListRemindersAction(store: ReminderStore): Action`,`capability:'time'`。
- `perform`:读 `store.list()`;空 → "目前没有提醒";非空 → 逐条列出(序号 + text + 可选 atIso)。纯读,无副作用。
- 与 `set_reminder` 共享同一 store 实例(`buildDefaultRegistry` 注入同一个),故能读到 `set_reminder` 写入的提醒。

## recall_fact

- 入参:`{ query: string }`,`required:['query']`。
- 接缝:`FactLookup = (query: string) => string | undefined`(同步,纯本地;返回 undefined/空 = 没查到)。
- `createRecallFactAction(lookup?: FactLookup): Action`;**缺省 lookup** 恒返回 `undefined`(语义:"暂不可用")。**不声明 capability**。
- `perform`:`query` 非字符串/空 → `isError`;调 `lookup(query)`,有结果 → 回结果;无结果 → "我暂时想不起关于「…」的事"(非 isError,属正常没查到)。
- **不 import memory**:只持有一个函数引用;真正接 memory 由调用方在别处注入回调(后续接线)。

## countdown

- 入参:`{ atIso: string }`,`required:['atIso']`,`capability:'time'`。
- `createCountdownAction(now: () => Date = () => new Date()): Action`(时钟注入,确定性)。
- `perform`:`atIso` 非字符串/不可解析 → `isError`(不抛);算 `targetMs - now().getTime()`:
  - 正 → "距 {atIso} 还有 X 天 Y 小时 Z 分"(按 d/h/m 拆,确定性整数运算)。
  - 负/0 → "{atIso} 已过去 …"(同样拆分,绝对值)。
- 时长拆分用整数毫秒运算(无随机、无浮点尾巴):`d=floor(ms/86400000)`,余下取 h、m。

## buildDefaultRegistry 装配

- 新签名(纯加项,既有可选项保留):`buildDefaultRegistry({ now?, reminderStore?, factLookup? })`。
- 注册顺序在既有 5 个之后追加:`list_reminders`(传 `reminderStore`)、`recall_fact`(传 `factLookup`)、`countdown`(传 `now`)。
- `set_reminder` 与 `list_reminders` 用**同一** `reminderStore`(缺省新建一个 `InMemoryReminderStore` 两者共享)。
- 既有 `current_time`/`set_reminder` 加 `capability:'time'`(不改其它行为)。
- 默认不配能力集(向后兼容)。

## 测试要点(§3.2)

- list_reminders:共享 store → set_reminder 写入后 list_reminders 能读到;空 store → 可读"没有提醒";`capability==='time'`。
- recall_fact:注入 lookup 命中 → 回结果(非 error);注入 lookup 未命中(undefined) → 正常"想不起"(非 error);缺省 lookup → "暂不可用"语义(非 error);缺/空 query → isError;`capability===undefined`。
- countdown:注入时钟 + 未来 atIso → 含剩余时长(非 error);过去 atIso → 含"已过去"(非 error);不可解析 atIso → isError;`capability==='time'`;同一注入时钟下结果确定。
- 能力标注:`current_time`/`set_reminder`/`list_reminders`/`countdown` 的 `capability==='time'`;`recall_fact`/`calculate`/`unit_convert`/`date_diff` 的 `capability===undefined`。
- buildDefaultRegistry:`size===8`;`toolDefs()` 含全部 8 个动作名;空能力集 `new Set()` 下只剩纯计算动作(`calculate`/`unit_convert`/`date_diff`/`recall_fact`),时间域动作被隐藏(验证标注真生效)。
- 向后兼容:默认 `buildDefaultRegistry()`(不配能力集)`toolDefs()` 含全部动作。
