## ADDED Requirements

### Requirement: LLM Provider 注册与 DashScope(Qwen)纯文本映射

系统 SHALL 通过 LLM Provider 注册表把开放字符串 `provider` 映射到具体实现;加新厂商 MUST 只需在注册表登记工厂,`createLlm` 核心与系统其余部分 MUST 零改动(承 §3.1 接缝)。其中 `qwen` MUST 注册为复用 `OpenAiCompatLlm` 的**纯文本** Provider,默认指向 DashScope OpenAI 兼容端点 `https://dashscope.aliyuncs.com/compatible-mode/v1`(承 §3.3 OpenAI 兼容复用)。该默认 base URL MUST 为具名常量(无 magic number),且 MUST 可经配置覆盖(`LlmConfig.baseURL` / 环境变量 `CHAT_A_LLM_BASE_URL`,承 §3.2 行为即配置)。`qwen` 工厂在 `apiKey` 缺失或为空时 MUST 抛清晰错误(指向应设的环境变量),而非静默构造不可用实例。本要求 MUST 仅覆盖纯文本 chat/completions + SSE 路径;多模态 audio-in(qwen omni 系列)不在本要求范围,留待后续独立能力。

#### Scenario: createLlm 解析 qwen 为 DashScope OpenAI 兼容 Provider

- **WHEN** 以 `{ provider:'qwen', model:'qwen-plus', apiKey:'<key>' }` 调用 `createLlm`
- **THEN** 返回 `OpenAiCompatLlm` 实例,其 `id` 为 `'qwen'`,`baseURL` 为 DashScope OpenAI 兼容端点默认值

#### Scenario: qwen 已登记于注册表

- **WHEN** 读取已注册的 LLM Provider 列表
- **THEN** 列表包含 `'qwen'`,加它未改动 `createLlm` 核心解析逻辑

#### Scenario: 缺 apiKey 抛清晰错误

- **WHEN** 以 `{ provider:'qwen', model:'qwen-plus' }`(无 apiKey)调用 `createLlm`
- **THEN** 抛出明确错误,提示需要设置 API key(环境变量),不返回不可用实例

#### Scenario: base URL 可经配置覆盖

- **WHEN** 以 `{ provider:'qwen', model, apiKey, baseURL:'https://自托管端点/v1' }` 调用 `createLlm`(或经 `CHAT_A_LLM_BASE_URL` 注入)
- **THEN** 返回实例的 `baseURL` 为覆盖后的端点(去尾斜杠),而非内置默认值

### Requirement: OpenAiCompatLlm 暴露只读 baseURL

`OpenAiCompatLlm` SHALL 暴露**只读** `baseURL`(已规整、去尾随斜杠),与已公开的 `id`/`model` 对称,仅供 trace/日志与可测性。该字段 MUST 为纯加法,不改变 `stream`/`complete`/工具通道的 fetch 行为。

#### Scenario: 读取规整后的 baseURL

- **WHEN** 以 `baseURL:'https://x.example/v1/'` 构造 `OpenAiCompatLlm` 并读取其 `baseURL`
- **THEN** 返回 `'https://x.example/v1'`(尾随斜杠被去除),且其 `stream`/`complete` 行为与本切片之前一致
