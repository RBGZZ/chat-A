## ADDED Requirements

### Requirement: OTel span 落 SQLite 的自定义 SpanProcessor/Exporter

系统 SHALL 提供自定义 `SpanProcessor` 与 `SpanExporter`,在 OTel span **结束(onEnd)**时把该 `ReadableSpan` 投影并落到 SQLite 的 `otel_spans` 表(§8.1 两层追踪「OTel→SQLite 落地」)。落库字段 MUST 含 `trace_id`、`span_id`、`parent_span_id`、`name`、`start`/`end`(**锚定语音真实墙钟时刻**,毫秒)、`duration`(毫秒)、`status`,以及可得时的 **GenAI 语义约定属性**(`gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`/`output_tokens`、`gen_ai.output.type`、`gen_ai.conversation.id`)。属性键 MUST 取自 `conventions`(`GENAI`/`CHAT_A`),不得散落 magic string(§3.2 单一命名)。span 投影 MUST 把 HrTime(`[秒, 纳秒]`)正确换算为毫秒。

导出 MUST 在主流程之外异步进行(onEnd 不同步阻塞写库),且导出/写库失败 MUST 优雅降级——只记日志,绝不向 OTel SDK 或主流程抛出(§3.2)。`SpanProcessor` MUST 提供 `forceFlush()`(排空待写队列,供测试断言前 flush)与 `shutdown()`(排空 + 释放 SQLite 句柄);二者内部异常 MUST 自吞。

#### Scenario: span 结束后落 SQLite 且字段正确

- **WHEN** 在装了该 SpanProcessor 的 provider 下开启一个 span,设置 GenAI 属性,结束它并 `forceFlush`
- **THEN** `otel_spans` 表出现一行,`trace_id`/`span_id`/`parent_span_id`/`name`/`start`/`end`/`duration`/`status` 与该 span 一致,GenAI 属性按约定键落库,HrTime 正确换算为毫秒

#### Scenario: 导出失败优雅降级不拖垮主流程

- **WHEN** 底层 SQLite 句柄已关闭或库路径不可写,span 结束触发导出
- **THEN** `onEnd`/`forceFlush`/`shutdown` 均不抛出,错误被记录,主流程不受影响

#### Scenario: 同 span 重复落库幂等

- **WHEN** 同一 `trace_id`+`span_id` 的 span 记录被写入两次
- **THEN** `otel_spans` 表中该 span 仅一行(`ON CONFLICT(trace_id, span_id)` upsert),不产生重复

### Requirement: OTel span 与 SQLite 决策记录同 ID 缝合

落库的 span MUST 与现有 SQLite 决策记录使用**同一套 `trace_id`/`span_id`**,使二者可在 SQLite 内缝合(§8.1:OTel 发现慢回合→凭 trace_id/span_id 跳到 SQLite 完整决策链)。当决策记录在某活动 OTel span 内写入时,其 `span_id` MUST 等于该 span 落 `otel_spans` 的 `span_id`,从而 `decision_traces.span_id` 与 `otel_spans.span_id` 可按相等关联。系统 SHALL 提供按 `trace_id`(+`span_id`)只读还原 span 的能力,供缝合查询与带外 CLI 使用,且该只读路径 MUST 在库/表缺失或损坏时降级为空结果而非崩溃。

#### Scenario: 决策记录与 span 在同库按 span_id 缝合

- **WHEN** 在一个活动 OTel span 内写入一条决策记录,并结束该 span 使其落 `otel_spans`(同库)
- **THEN** 该决策记录的 `span_id` 等于 `otel_spans` 中该 span 的 `span_id`,可凭 `trace_id`+`span_id` 同时取回决策链与 span 阶段耗时

#### Scenario: 只读还原降级

- **WHEN** 对一个不存在或无 `otel_spans` 表的库做按 trace_id 还原 span
- **THEN** 返回空结果并告警,不抛出、不崩溃

### Requirement: 两侧分治采样(OTel 可采样、SQLite 不采样全量)

系统 SHALL 让 OTel 追踪侧**可采样**(运维/传输噪声可控),同时保证 SQLite 决策真相源**不采样、全量落**(§8.1 单一真相源)。为此 `initTelemetry` SHALL 支持注入 `Sampler`,且**不注入时默认 `AlwaysOn`**,以保证自定义 SpanProcessor 在 `onEnd` 能拿到全量 span 写入 SQLite。OTel 侧若需降噪,SHOULD 在导出链路而非 provider sampler 上采样;provider sampler 一旦设为非全采,被采掉的 span 不会触发 `onEnd`,SQLite 将随之缺失该 span——故真相源全量场景 MUST 保持 provider sampler 为全采。采样开关/采样率/批量阈值 MUST 外置为配置,给合理默认,无 magic number(§3.2 行为即配置)。

#### Scenario: 默认全采使 SQLite 拿到全量 span

- **WHEN** `initTelemetry` 不传 `sampler`,装上 SQLite SpanProcessor,开启并结束多个 span
- **THEN** 全部 span 均落入 `otel_spans`(默认 AlwaysOn,不采样真相源)

#### Scenario: provider 采掉则 SQLite 缺失该 span

- **WHEN** 以 `AlwaysOff` sampler 初始化 provider,开启并结束 span
- **THEN** span 不被记录、`onEnd` 不被调用,`otel_spans` 无对应行——印证采样发生在 provider 侧、SQLite 只落它收到的 span(故真相源须配全采)

### Requirement: span 落 SQLite 的版本化迁移与 env 装配

`otel_spans` 表 SHALL 经版本化迁移建立与演进:库 MUST 记录独立的 span schema 版本(`span_meta` KV),迁移 MUST 顺序执行、单事务、失败回滚,且 MUST NOT 丢失已有数据(§3.2 数据迁移纪律);版本高于代码支持时 MUST 明确报错而非静默损坏。系统 SHALL 提供 `createSpanProcessorFromEnv(env)` 从环境变量装配:默认**关闭**(返回未启用占位,零成本);`CHAT_A_OTEL_SPAN_SQLITE` 为真值时启用并产出可注入 `initTelemetry({ spanProcessors })` 的 SpanProcessor,库路径取 `CHAT_A_OTEL_SPAN_SQLITE_DB`(默认与决策 trace 同库共存),批量阈值取 `CHAT_A_OTEL_SPAN_SQLITE_BATCH`。

#### Scenario: 默认关闭零成本

- **WHEN** 环境未设 `CHAT_A_OTEL_SPAN_SQLITE`,调用 `createSpanProcessorFromEnv`
- **THEN** 返回未启用结果,不创建 SQLite 句柄、不挂 processor

#### Scenario: 开启后产出可注入的 processor

- **WHEN** 设 `CHAT_A_OTEL_SPAN_SQLITE=1` 与库路径,调用 `createSpanProcessorFromEnv`
- **THEN** 返回启用结果,含一个可塞进 `initTelemetry` 的 SpanProcessor 与解析出的库路径

#### Scenario: 重开旧库迁移幂等且不丢数据

- **WHEN** 重复打开同一 span 库
- **THEN** 不重建、不报错、`span_meta` 版本号稳定,既有 span 行保留
