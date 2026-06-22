## Context

需求见 `proposal.md` 与 `specs/llm-cognition/spec.md`。现状:`DefaultAppraiser`(确定性词典,packages/persona)、记忆"存用户原话"(packages/runtime Conversation)、`LlmProvider` 仅 `stream()`。本次补 Provider 非流式 `complete`,并兑现 §6.1 的 LLM 情绪评估 + §5.8 的 LLM 记忆抽取,均带开关、默认不变。约束:厂商无感、LLM 走 schema+record-replay、行为即配置、优雅降级、严守延迟预算(§3.2)。

## Goals / Non-Goals

**Goals:**
- `LlmProvider.complete(req): Promise<string>`(anthropic/deepseek/fake),厂商无感。
- LLM Appraiser(OCC→PAD)与确定性默认并存、可切、默认关、失败回退。
- `MemoryExtractor` 接缝 + LLM 实现,回合后抽取要点→ADD+去重;可切、默认关、失败跳过。
- 默认配置**零首字延迟**(评估滞后一轮、抽取在回合后)。
- 容错 JSON 解析;全程优雅降级,不打断回合。

**Non-Goals:**（见 proposal）流式结构化输出、各家原生 structured-output API、appraisal 折叠进主回复、二级 OCEAN 演化、向量召回/语义去重。

## Decisions

### D1. `LlmProvider.complete(req): Promise<string>`(非流式补全)
- 复用现有 `LlmRequest`;返回完整文本。`AnthropicLlm`(**按 claude-api 技能写,非流式 messages.create**)、`OpenAiCompatLlm`(`/chat/completions` `stream:false` 取 `choices[0].message.content`)、`FakeLlm`(返回可配置罐装串,供 record-replay)。
- 仍厂商无感:调用方不据 id/model 分支(仅 trace)。
- **为何不上各家原生 structured-output**:避免 provider 接缝按厂商分裂;统一"complete + 提示要 JSON + 容错解析",够用且保持开放注册表简单。

### D2. 容错 JSON 解析(放 `@chat-a/providers`,供 persona/memory 共用)
- `tolerantJsonParse(text): unknown | null`:剥 ```json``` 围栏 / 取首个平衡 `{...}` / `JSON.parse`;失败返回 null。调用方再做字段校验(缺省/丢弃)。
- 放 providers(persona、memory 本就将依赖它),单一实现不漂移。

### D3. Appraiser 改为异步 + LLM 实现
- `Appraiser.appraise(ctx): Promise<PadPull>`(由同步改异步,以容纳 LLM)。`DefaultAppraiser` 包成已决议 Promise(确定性不变)。
- `LlmAppraiser`(在 `@chat-a/persona`,**persona 新依赖 `@chat-a/providers` 取 `LlmProvider` 类型**):用 `complete` 发"给这条消息打 PAD 拉力 JSON"的提示 → `tolerantJsonParse` → 校验/钳制为 `PadPull`;**任何失败回退内置 `DefaultAppraiser`**。

### D4. PersonaEngine 拆 render / advance(零首字延迟的关键)
- `tone(): { emotion, toneFragment }`:从**当前** PAD 渲染,不改状态(回合前用,纯同步)。
- `advance(userText): Promise<void>`:appraise(异步)→ `stepPad` → 持久化(回合**后**用)。
- 回合时序:`tone()` 构造本轮 system → 流式回复 → 回合后 `await advance()`。**心情滞后一轮影响下一轮**,换取首字零额外延迟(§3.2)。可配置改回合前(影响当轮、承担延迟),非默认。
- 影响:`observe()` 一体式被 `tone()`+`advance()` 取代,更新 persona/runtime 既有调用与测试。

### D5. MemoryExtractor 接缝
- 放 `@chat-a/memory`(**memory 新依赖 `@chat-a/providers`**):`MemoryExtractor.extract(userText, reply): Promise<readonly MemoryInput[]>`。
- `LlmMemoryExtractor`:`complete` + "抽取要点/偏好 JSON 数组" + `tolerantJsonParse` + 校验;失败返回 `[]`(跳过)。`NoopMemoryExtractor`(默认,返回 `[]`)。
- 回合时序:流式回复后,`Conversation` `await extract()` → 逐条 `addMemory`(复用 ADD+去重)。开启时替换"存原话";关闭时保持既有 naive 写入。不阻塞首字。

### D6. 配置(行为即配置)
- `CHAT_A_APPRAISER = default(默认) | llm`;`CHAT_A_MEMORY_EXTRACT = off(默认) | llm`。
- LLM 评估/抽取**复用主 Provider**(`createLlm(cfg)`);是否用更便宜的小模型留作后续(开关预留,不在本次)。
- 默认值保证既有 CLI/测试不变。

### D7. 可追溯(§8.1)
- appraisal / extraction 作为 turn span 的子 span(`appraise` / `extract`),复用 GenAI 属性;错误经 onError 记录。轻量,随手加。

## Risks / Trade-offs

- **Appraiser 变异步 → 触及 persona/runtime 既有 API 与测试** → 一次性改清楚;numeric 内核仍同步纯函数,golden 不动。
- **心情滞后一轮**(默认 post-turn)→ 可接受甚至更自然;需当轮影响者可配置 pre-turn(担延迟)。
- **开启时回合末多 1~2 次 LLM 调用(评估+抽取)** → 不在流式首字路径;文档标注;默认关。
- **JSON 解析脆弱 / LLM 不守格式** → `tolerantJsonParse` + 字段校验 + 失败回退/跳过;record-replay 覆盖乱码用例。
- **persona/memory 新增对 providers 的依赖** → 仅取类型/接缝,providers 不反依赖,无环;符合 §3.1(依赖接口)。

## Migration Plan

1. providers 加 `complete` + `tolerantJsonParse`,各实现;不改既有 stream 行为。
2. persona:Appraiser 异步化、引擎拆 `tone`/`advance`、加 `LlmAppraiser`;默认仍 `DefaultAppraiser`,行为不变。
3. memory:加 `MemoryExtractor` 接缝 + Noop/LLM 实现。
4. runtime:回合时序改 `tone`(前)/`advance`+`extract`(后);默认走 Noop extractor + naive addMemory,既有测试不破。
5. client:加 `CHAT_A_APPRAISER` / `CHAT_A_MEMORY_EXTRACT` 装配。
6. 回滚:两开关回默认即恢复确定性 appraiser + naive 记忆;`complete` 为新增方法,不影响 stream 路径。

## Open Questions

- 评估/抽取是否用独立小模型(省钱省延迟)vs 复用主 Provider——本次复用,开关预留。
- 抽取要点的"subject(user/agent)"与种类标注粒度——P1 取最小(text + kind),subject 细分留后。
- pre-turn appraisal 模式是否值得做满(当前仅留配置位,默认 post-turn)。
