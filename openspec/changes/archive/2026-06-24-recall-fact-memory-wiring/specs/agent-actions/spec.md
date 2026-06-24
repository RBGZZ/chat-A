## MODIFIED Requirements

### Requirement: 内置本地动作 recall_fact(注入回调,不依赖 memory)

系统 SHALL 内置一个纯本地动作 `recall_fact`,入参 `{ query: string }`,经一个**注入的事实查询回调** `(query: string) => string | undefined` 查询并回灌结果。该动作 MUST NOT 依赖 memory 包(只持有注入的函数引用);**缺省回调** SHALL 表达"暂不可用"(查不到)。回调返回空/`undefined` 时 SHALL 返回"没找到/想不起"之类可读结果(属正常未命中,**非** `isError`)。`query` 缺失或为空 SHALL 返回 `isError:true`(不抛)。该动作 SHALL NOT 声明 `capability`(纯本地查询,任何设备可用)。

系统 SHALL 另提供一个**把真实召回存储适配为该注入回调的接缝**(适配器),使 `recall_fact` 能接真实记忆检索而 interaction 仍**不依赖 memory 包**:适配器 MUST 仅通过一个**最小结构契约**(只需 `recall(query, limit?)` 返回带 `text` 的记录序列)消费存储,MUST NOT import 具体 memory 实现(用结构化类型解耦,§3.1);memory 的 `MemoryStore`/`MemoryRecord` 天然满足该形状。适配器 SHALL 将 `recall` 结果按**可配置 topN**截断、取非空文本拼接成一条事实串返回;topN 等参数 MUST 外置为可配置(无 magic number,承 §3.2)。适配器 MUST **优雅降级**(承 §3.2「永不崩永不哑」):检索为空、命中文本全为空白、或 `recall` 抛错时,SHALL 返回 `undefined`(交由 `recall_fact` 表达"想不起",**非崩溃、非** `isError`),绝不把检索故障抛给回合。

#### Scenario: 注入回调命中返回结果

- **WHEN** 注入回调对某 query 返回非空字符串,调用 `recall_fact` 传该 query
- **THEN** 返回 content 含回调结果,`isError` 缺省/false

#### Scenario: 未命中返回正常说明(非错误)

- **WHEN** 注入回调对该 query 返回 `undefined`(或使用缺省"暂不可用"回调)
- **THEN** 返回可读的"没找到/想不起"结果,`isError` 缺省/false(非错误)

#### Scenario: 缺 query 返回错误

- **WHEN** 调用 `recall_fact` 缺少 `query` 或 `query` 为空串
- **THEN** 返回 `isError:true` 的结果,不抛异常

#### Scenario: 不声明 capability

- **WHEN** 读取 `recall_fact` 动作的 `capability`
- **THEN** 其值为 `undefined`

#### Scenario: 适配真实召回存储后命中走真检索

- **WHEN** 用一个满足最小结构契约的存储(对某 query 的 `recall` 返回非空记忆记录)构造适配回调,并以该回调驱动 `recall_fact` 传该 query
- **THEN** `recall_fact` 返回 content 含召回到的记忆文本,`isError` 缺省/false

#### Scenario: 召回多条受 topN 截断

- **WHEN** 存储对某 query 的 `recall` 返回多于 topN 条记录,经适配回调召回(指定 topN)
- **THEN** 回调把存储的 `limit` 设为 topN 并最多取前 topN 条非空文本拼接返回,超出部分不出现在结果中

#### Scenario: 检索为空或出错优雅降级

- **WHEN** 存储对某 query 的 `recall` 返回空、或命中文本全为空白、或 `recall` 抛错
- **THEN** 适配回调返回 `undefined`,`recall_fact` 据此返回"想不起"可读结果(非 `isError`),全程不抛、不崩
