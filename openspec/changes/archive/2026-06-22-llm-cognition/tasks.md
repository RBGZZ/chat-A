## 1. Provider 非流式补全

- [x] 1.1 `LlmProvider` 接口加 `complete(req: LlmRequest): Promise<string>`。
- [x] 1.2 `FakeLlm.complete`:返回可配置罐装串(record-replay 用);默认回声式占位。
- [x] 1.3 `OpenAiCompatLlm.complete`:`/chat/completions` `stream:false`,取 `choices[0].message.content`;错误抛出含状态码。
- [x] 1.4 `AnthropicLlm.complete`:**按 claude-api 技能**写非流式 messages 调用,取文本。
- [x] 1.5 测试:fake/openai-compat complete 返回完整文本(openai-compat 可对罐装 HTTP 或跳过真网);registry 实现齐备。

## 2. 容错 JSON 解析

- [x] 2.1 `@chat-a/providers` 加 `tolerantJsonParse(text): unknown | null`(剥围栏 / 取首个平衡 `{...}`/`[...]` / JSON.parse;失败 null)。
- [x] 2.2 单测:带 ```json 围栏```、前后夹带文字、纯非法 三类。

## 3. LLM Appraiser（persona）

- [x] 3.1 `@chat-a/persona` 依赖 `@chat-a/providers`;`Appraiser.appraise` 改为返回 `Promise<PadPull>`;`DefaultAppraiser` 适配(同步逻辑包成 resolved Promise)。
- [x] 3.2 实现 `LlmAppraiser`(complete + 要 PAD JSON + tolerantJsonParse + 校验/钳制);失败回退内置 `DefaultAppraiser`。
- [x] 3.3 record-replay 测试:罐装合规 JSON→负面消息得负 pull;乱码→回退确定性 pull;均落合法区间。

## 4. PersonaEngine 拆 render / advance

- [x] 4.1 `PersonaEngine` 拆出 `tone(): {emotion,toneFragment}`(读当前 PAD 不改状态)与 `advance(userText): Promise<void>`(appraise→stepPad→持久化);保留 `current()`。
- [x] 4.2 更新 persona 既有测试(engine.test)与 runtime 既有用法到新 API。

## 5. MemoryExtractor（memory）

- [x] 5.1 `@chat-a/memory` 依赖 `@chat-a/providers`;定义 `MemoryExtractor.extract(userText, reply): Promise<readonly MemoryInput[]>` + `NoopMemoryExtractor`(默认,返回 [])。
- [x] 5.2 实现 `LlmMemoryExtractor`(complete + 抽取 JSON 数组 + tolerantJsonParse + 校验);失败返回 []。
- [x] 5.3 测试:罐装两条(含与既有等价者)→ 写入去重;乱码→空、回合不受影响。

## 6. 接线回合（runtime）

- [x] 6.1 `Conversation` 时序改:回合前 `tone()` 构造 system(骨架→召回→tone);流式回复;回合后 `await advance(userText)`。
- [x] 6.2 回合后抽取:若注入 extractor,`await extract(userText, reply)` 逐条 `addMemory`;否则保持既有 naive `addMemory(userText)`。
- [x] 6.3 appraisal/extraction 包 try/catch 降级(失败不打断回合,记录错误);可选 `appraise`/`extract` 子 span(§8.1)。
- [x] 6.4 更新 runtime 既有测试(conversation/persona-turn)到新时序;新增降级用例(appraiser/extractor 抛错→回合仍完成)。

## 7. 配置 / 客户端

- [x] 7.1 `CHAT_A_APPRAISER=default|llm`、`CHAT_A_MEMORY_EXTRACT=off|llm` 装配(默认保持既有行为);LLM 实现复用主 Provider。
- [x] 7.2 `packages/client` 按配置注入 `LlmAppraiser` / `LlmMemoryExtractor`;启动行标注当前 appraiser / extract 模式。

## 8. 收尾验证

- [x] 8.1 全量 `pnpm typecheck` + `pnpm test` 通过(含新 record-replay、降级、去重;既有契约/golden 不破)。
- [x] 8.2 端到端冒烟:`start.bat` 开 `CHAT_A_APPRAISER=llm` + `CHAT_A_MEMORY_EXTRACT=llm` 走真实 DeepSeek,验证心情随语义起伏(下一轮)+ 抽取要点入库 + 关掉开关回退正常;无报错、首字不卡。
