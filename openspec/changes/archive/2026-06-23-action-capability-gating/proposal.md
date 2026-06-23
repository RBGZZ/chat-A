## Why

canonical §12.2 要求"**能力门**:动态隐藏设备不支持的动作"——小雪最终上树莓派等嵌入式设备(无屏幕/无音频/无网络等差异),同一份动作集在不同终端上能力不同:在没有音频外设的瘦终端上暴露"播放声音"类工具只会让模型徒劳调用、再吃一个 isError。当前 `ActionRegistry` 把**所有**已注册动作无条件产出给 Provider、无条件执行,没有"这台设备支不支持"这一层。

本 change 落地能力门的**雏形**:给 `Action` 一个可选 `capability`(声明它需要的设备/环境能力),给 `ActionRegistry` 一个可选的"当前能力集"。授权过滤发生在 `toolDefs()`(只把已授权动作喂给模型,从源头隐藏)与 `execute()`(对未授权动作**容错拒绝**,返回 isError 而非抛错,§3.2)。这是纯加法、**缺省全开**:不传能力集时行为与现状逐字等价,现有装配与测试不受影响。

## What Changes

- `Action` 接缝**新增可选** `capability?: string`:声明该动作需要的能力标签(如 `'time'`/`'audio'`)。缺省(未声明)= 无需任何能力,**始终可用**(行为即配置,§3.2)。
- `ActionRegistry` 支持"**当前能力集**" `Set<string>`:可经构造参数传入,亦可经方法设置/更新。
  - `toolDefs()`:只产出**已授权**动作的工具定义(动作无 `capability`,或其 `capability` 在能力集内)。从源头对模型隐藏不支持的动作(§12.2)。
  - `execute()`:对**未授权**动作**容错拒绝**——返回 `isError:true` 且 `toolCallId` 对齐的 `ToolResult`(含可读说明),**绝不抛**(§3.2)。
  - **缺省 = 全部可用**:未配置能力集时,`toolDefs()`/`execute()` 行为与现状逐字一致(向后兼容)。
- 新增 1 个纯本地、**确定性**动作 `date_diff`(两日期相差天数;入参 `{ from, to }` ISO 日期)——不引随机、不接外部进程。
- 测试:授权过滤 `toolDefs`、未授权 `execute`→isError 不抛、缺省全开兼容、能力集更新、`date_diff` 正反例;`buildDefaultRegistry()` 现有行为(无能力集=全开)不变。

## Capabilities

### Modified Capabilities
- `agent-actions`: `Action` 新增可选 `capability` 字段;`ActionRegistry` 新增"当前能力集"概念并据此过滤 `toolDefs()` / 容错拒绝 `execute()`(缺省全开,向后兼容);新增内置动作 `date_diff`。

## Impact

- **`packages/interaction/src/types.ts`**:`Action` 加可选 `capability?: string`(纯加法,exactOptionalPropertyTypes 下条件展开)。
- **`packages/interaction/src/registry.ts`**:`ActionRegistry` 持有可选能力集(构造参数 + setter/with 方法);`toolDefs()` 过滤未授权;`execute()` 容错拒绝未授权;缺省无能力集=全开。
- **`packages/interaction/src/actions/date-diff.ts`**(新增):确定性动作 `date_diff`。
- **`packages/interaction/src/index.ts`**:导出 `date-diff`;`buildDefaultRegistry()` 注册 `date_diff`,**不**默认设能力集(全开,现有行为不变)。
- **`packages/interaction/test/registry.test.ts`** 等:补能力门 + `date_diff` 测试;现有 `size`/`toolDefs` 断言因新增动作数从 4→5 在 interaction 包内同步更新。
- 影响 canonical 章节:**§12.2**(能力门动态隐藏不支持的动作)雏形;承 §3.2(优雅降级:未授权容错拒绝不抛 / 缺省全开)。
- **延迟**:仅在 `toolDefs()`/`execute()` 增一次 `Set.has` 判断,无新增 I/O / await,首字延迟不变(§3.2)。
- **非破坏**:不传能力集时对外逐字等价;只改 `packages/interaction/**`,不触碰其它任何包,不动持久化 schema。

### Non-goals
- 能力集的**来源/发现**(从设备探测/握手得出当前能力)——本期能力集由调用方传入,设备探测是后续。
- 运行期热更新通知/事件、能力变化广播。
- 多能力依赖(`capabilities: string[]`)、能力分级/降级回退动作——本期单一 `capability?: string` 即足够雏形。
- 随机类动作(避开不确定性);本期新动作只取确定性的 `date_diff`。
