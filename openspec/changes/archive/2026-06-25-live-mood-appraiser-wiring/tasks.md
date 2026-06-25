## 1. persona:PersonaEngine.reload()

- [x] 1.1 给 `PersonaEngine` 加 `reload(): void`:`#snapshot = this.#store.load() ?? this.#snapshot`(只读 store、不 advance、不写回);store 空时保持现状。
- [x] 1.2 单测:A 引擎 advance+save 后,B 引擎(同 store)reload → tone()/current() 反映新 PAD;store 空 reload 不变不抛;reload 不触发 advance/不写回(用 mock store 断言 save 未被调)。

## 2. 装配:appraiser 接进 assembleApp

- [x] 2.1 `app.ts` 读 `CHAT_A_APPRAISER`(镜像 cli.ts:50);`=llm` → `new LlmAppraiser({ provider: llm })`,否则 undefined。**并把 `LlmAppraiser` 加进 app.ts 的 `@chat-a/persona` import 块**(当前未含)。
- [x] 2.2 makeConvo 透传 `...(appraiser ? { appraiser } : {})` 给 `new Conversation`;核对 reset/applyPersona/applyLang 重建 convo 都经同一 makeConvo(闭包捕获 appraiser,自动续接)。
- [x] 2.3 回归断言:不设 CHAT_A_APPRAISER 时 makeConvo 产出的 Conversation 不带 appraiser(行为现状);=llm 时带。

## 3. desktop:回合后读活 PAD

- [x] 3.1 `main.ts` turn:end handler(`main.ts:495-497`):`emit(IPC.mood, ...)` 前 `handle.persona.reload()`(try/catch 失败用旧值)。⚠️ **仅** turn:end(497)+ speakReply(438,见 3.2)两处需 reload;**applyPersona 后(652)与启动初始(775)不要加 reload**——那两处显示引擎是新建/刚从 store load 的、本就最新(审查核实,误加无益)。
- [x] 3.2 emotion-aware-voice 朗读:`speakReply` 读 `handle.persona.tone().voiceInstruction` 前先 `handle.persona.reload()`(确保读活 PAD);失败降级照旧。
- [x] 3.3 确认 handle.persona getter 可达 reload(engine 自带方法);若需经 handle 暴露则补最小入口。

## 4. 收口与校验

- [x] 4.1 全量 `pnpm -r typecheck` + 相关包测试绿(persona/client/desktop);新增 reload golden + appraiser 装配断言。
- [x] 4.2 desktop typecheck + bundle 构建通过。
- [x] 4.3 `openspec validate live-mood-appraiser-wiring --strict` 通过。
- [x] 4.4 README/记忆补:`CHAT_A_APPRAISER=llm` 在 desktop 现已生效 + 活 PAD 修复。
- [ ] 4.5(真机,待用户)`CHAT_A_APPRAISER=llm` + `CHAT_A_TTS_EMOTION_FROM_MOOD=on` 重启:连发情绪句,听音色是否随心情起伏(开心/低落档真触发)。
