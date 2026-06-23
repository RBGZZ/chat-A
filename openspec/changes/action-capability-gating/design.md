## Context

canonical §12.2 的能力门要"动态隐藏设备不支持的动作"。当前 `ActionRegistry` 无此层:`toolDefs()` 把全部动作喂模型,`execute()` 对任何已注册动作都尝试执行。本设计是能力门**雏形**——足够小、纯加法、缺省全开,为后续"设备探测 → 能力集"留接缝。

约束:只改 `packages/interaction/**`;`exactOptionalPropertyTypes` 开;优雅降级(§3.2);行为即配置(能力声明随动作走,能力集外置由调用方传)。

## Goals / Non-Goals

- Goals:动作可声明所需能力;注册表可配当前能力集;`toolDefs()` 只产授权动作;`execute()` 对未授权容错拒绝(不抛);**缺省全开**向后兼容;补一个确定性新动作。
- Non-Goals:能力探测/发现、热更新事件、多能力依赖、随机动作。

## Decisions

### D1:`capability` 是 `Action` 上的**单个可选字符串**
- `capability?: string`,缺省 = 无需能力、始终授权。单字符串足够雏形;多能力(`string[]`)留后续,避免过度设计。
- 能力**声明**随动作走(动作自知需要什么),能力**集**由调用方按设备传入——声明与环境解耦(行为即配置)。

### D2:能力集是注册表的**可选状态**,缺省 = "无门"(全开)
- 用 `Set<string> | undefined` 表达:`undefined` = **未配置能力门 = 全部授权**(向后兼容,现有行为逐字不变);一旦传入(哪怕空 Set)= 门已开启,按集合判定。
- 提供两种配置途径:
  - 构造参数 `new ActionRegistry(capabilities?)`(装配期一次定);
  - 方法 `withCapabilities(set)` 返回 this(链式更新/运行期切换设备能力)。
- 授权判定 `#isAuthorized(action)`:能力集为 `undefined` → true;否则 `action.capability === undefined`(无需能力)→ true;否则 `set.has(action.capability)`。

### D3:过滤点 = `toolDefs()`(隐藏)+ `execute()`(拒绝),双保险
- `toolDefs()`:`filter(#isAuthorized)` 后再映射——从源头不把未授权动作给模型看(§12.2 "隐藏")。
- `execute()`:即便模型凭历史/越权发来未授权调用,先查注册、**再查授权**;未授权 → 返回 `isError:true`、`toolCallId` 对齐的 `ToolResult`(不抛,§3.2)。两层都拦,模型既看不到、也调不动。
- 顺序:`execute()` 先判"未知工具"(动作不存在)再判"未授权"(动作存在但能力不足),错误信息分别可读,便于追溯。

### D4:新动作 `date_diff` —— 确定性、无能力依赖
- 入参 `{ from: string, to: string }`(ISO 日期/时间);返回相差**天数**(`to - from`,可负,向下不取整保留小数天?——取**整天差**:按 UTC 毫秒差 / 86_400_000,保留到合理精度)。为确定性,纯算术、无 `Date.now()`。
- 不可解析的日期 → `isError:true`(不抛),与既有动作的容错风格一致。
- 不声明 `capability`(纯本地计算,任何设备都支持)→ 永远授权,适合做"缺省全开仍含它"的基线。
- 避开随机:本期不引入需种子的 `random`,以免给确定性内核(§3.2)添不确定源。

### D5:`buildDefaultRegistry()` 不默认设能力集
- 仍 `new ActionRegistry()`(无能力集 = 全开),注册含 `date_diff` 在内的全部内置动作。现有调用方行为逐字不变;能力门是上层按设备**显式**启用的能力。

## Risks / Trade-offs

- **现有 size/toolDefs 断言变更**:内置动作 4→5,interaction 包内相关断言同步更新(范围受控,仅本包测试)。
- **空 Set 语义**:空 Set = "门已开、但什么能力都没有" → 仅无 `capability` 的动作可用。与 `undefined`(全开)区分清晰,文档/注释点明,避免误用。
- **单能力 vs 多能力**:雏形选单 `capability?`,若将来某动作需多能力,可平滑升级为 `string[]` 或加 `capabilities?`,本期接缝不阻碍。

## Migration Plan

纯加法、缺省全开:无数据迁移。未配置能力集的现有装配/测试零行为变化;仅新增动作使内置计数 +1,在 interaction 包内同步断言。
