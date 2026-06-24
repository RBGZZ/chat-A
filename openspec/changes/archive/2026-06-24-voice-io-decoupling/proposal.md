## Why

**§4.1 语音 I/O 输入/输出语种解绑**只有接缝积木、没接进跑动链路:**用户可用一种语言说、小雪按设定语言答**这件事还没法配。

- **接缝已就位**:`SttOptions.language?`(省略=自动检测)+ `SttCapabilities.languages` + `assertSttLanguage`;`TtsOptions{language?,voiceId?,refAudio?}` + `TtsCapabilities` + `assertTtsLanguage`/`assertTtsCloning`(`packages/providers/src/{stt.ts,tts.ts}`)都已实现并被 Fake/真 provider 消费。
- **但链路没传**:`packages/runtime/src/voice-loop.ts` 的 `#transcribe` 调 `this.#stt.transcribe(toChunks())`(**不传 opts.language** → STT 永远自动检测);`#speak`/omni 合成处调 `this.#tts.synthesize(sentence, undefined, signal)`(**opts=undefined** → 从不传 language/voiceId/refAudio)。LLM 侧也无"用目标语种回复"的注入——`output_lang` 设了也没人理。

本 change 是**纯接线/接缝层**:在 providers 加一个 **voice 配置块加载器**(env + 可选 persona card `voice:` 段),把 `input_lang` 透传成 `SttOptions.language`、`output_lang`/`voice_id`/`clone_ref` 透传成 `TtsOptions`,并新增 `OutputLanguageContributor`(cognition)在 `output_lang` 非空时温和注入"用<目标语种>回复"。能力门 fail-fast 复用既有 `assertSttLanguage`/`assertTtsLanguage`。**不重写任何模块内部**,只调既有公开 API、纯加法注入端口。

**硬线(回归绿是底线)**:**不配置 voice 语种时行为逐字不变**——STT 仍自动检测(不传 language)、`synthesize` opts 仍 `undefined`、LLM 无输出语种注入;既有全量测试全绿不可破。多 provider 按语种自动切换(进阶)、真机/真网络**不在本 change 验证**,用 Fake/Stub + 注入端口写不触网单测。

## What Changes

- **voice 配置块(providers)**:新增 `voice-profile.ts` —— `VoiceProfile { inputLang?, outputLang?, voiceId?, cloneRef? }` + `loadVoiceProfile(env)`。来源 env:`CHAT_A_VOICE_INPUT_LANG`(auto|zh|en|ja…,默认 `auto`=不下发=自动检测)/ `CHAT_A_VOICE_OUTPUT_LANG`(默认空=不强制)/ `CHAT_A_VOICE_ID` / `CHAT_A_VOICE_CLONE_REF`(refAudio 路径)+ `CHAT_A_VOICE_CLONE_REF_TEXT` / `CHAT_A_VOICE_CLONE_REF_LANG`。`input_lang=auto`/空 → `inputLang` 省略(键缺席);`output_lang` 空 → `outputLang` 省略。**无 magic、行为即配置**。可选解析 persona card `voice:` 段(cli 装配层,纯加法)。
- **voice-loop 透传(runtime)**:`VoiceLoopDeps` 新增可选 `sttLanguage?: string` + `ttsOptions?: TtsOptions`(经注入,VoiceLoop **不直接 import** providers config)。`#transcribe` 在有 `sttLanguage` 时传 `{ language }` 给 `transcribe`;`#speak` 在有 `ttsOptions` 时传给 `synthesize`(覆盖现 `undefined`)。**未注入 → 传 undefined → 逐字现状**(`transcribe(toChunks())` / `synthesize(sentence, undefined, signal)`)。
- **LLM 输出语种注入(cognition)**:新增 `OutputLanguageContributor` —— `ctx.outputLang` 非空时注入一句温和"请用<目标语种>回复"(priority 可配,放高注意力区);为空 → 返回 `null`(零注入)。`PromptContext` 新增可选 `outputLang?`;`Conversation` 构造期把它注册进 `PromptAssembler`(无 outputLang 时恒返回 null → 默认路径零改),并经 `ConversationDeps.outputLang` → `composeSystem` → `PromptContext.outputLang` 透传。
- **能力门 fail-fast(§4.3)**:语种经既有 `assertSttLanguage`/`assertTtsLanguage` 拦截(provider 内已调,VoiceLoop 透传不支持语种时清晰报错)。多 provider 按语种自动切换标注 future,本 change 不做。
- **cli 装配(client)**:`startVoiceMode`/`VoiceModeDeps` 透传 voice profile → loopDeps 的 `sttLanguage`/`ttsOptions`;`Conversation` 注入 `outputLang`。缺省(env 全空、无 card voice 段)→ 不透传 → 全链路逐字现状。

## Non-goals

- **不碰 `packages/providers/src/{gpt-sovits-tts.ts,tts-registry.ts}`**(并行 agent B 在做 GPT-SoVITS 引擎)。
- **不碰** memory / persona **内部**(persona 仅只读 card 的 `voice:` 段)。
- **不做多 provider 按语种自动切换/路由**(进阶,注释标 future);本 change 只把单一已配 provider 的 language/voice 透传下去 + 能力门 fail-fast。
- **不改 VoiceLoop 打断核心 / 状态机 / omni 直路语义**:只在 `#transcribe`/`#speak` 透传可选 opts。
- **不在热路径阻塞**:contributor 同步无 I/O;voice profile 装配期一次性解析。

## Impact

- **影响 canonical 章节**:§4.1(输入/输出语种解绑、用户配置、可热调)、§4.3(能力门 fail-fast)、§5.4(新增一个 PromptContributor)、§3.1(只经类型化接缝/注入端口,VoiceLoop 不依赖 providers config)、§3.2(默认安全 + 优雅降级)。与权威设计一致。
- **代码**:`packages/providers/src/voice-profile.ts`(新增 + index 导出)、`packages/runtime/src/voice-loop.ts`(`#transcribe`/`#speak` 透传 + deps 字段)、`packages/cognition/src/prompt/{contributors.ts,types.ts,config.ts,index.ts}`(`OutputLanguageContributor` + `outputLang` + priority)、`packages/runtime/src/{conversation.ts,turn-shared.ts}`(注册 contributor + `outputLang` 透传)、`packages/client/src/{cli.ts,cli-voice.ts}`(装配)。
- **依赖**:复用各包既有导出;不引新依赖。
- **延迟预算**:STT/TTS 透传零额外延迟;contributor 同步纯字符串拼接;voice profile 装配期解析一次。**对首字延迟零影响**。
- **降级/默认**:env 全空 / card 无 voice 段 → `VoiceProfile` 各键缺席 → STT 不传 language、TTS opts=undefined、LLM 无注入。能力门 fail-fast 用既有断言(语种不支持清晰报错而非静默)。
- **测试**:Fake STT/TTS/LLM + 注入 voice 配置(不触网):`input_lang`→STT opts.language、`output_lang`→TTS opts.language + LLM 注入目标语种句、`voice_id`→voiceId、`clone_ref`→refAudio 透传到 synthesize;**未配置全链路回归绿**(STT 无 language、synthesize opts=undefined、无输出语种注入);既有全量回归保持绿。
- **真机/真网络待验证(本 change 不验证)**:真 Whisper/Deepgram 跨语种自动识别质量、真 TTS 多语种发声、真 LLM 按注入语种切换回复、真音色复刻参数透传效果、免提连续跨语种对话体验。

## Capabilities

### Modified Capabilities
- `voice-mode-wiring`: 新增"语音 I/O 输入/输出语种解耦透传"要求——voice 配置块(env + 可选 card `voice:` 段)解析为 `VoiceProfile`;VoiceLoop 经注入的 `sttLanguage`/`ttsOptions` 把 `input_lang`→`SttOptions.language`、`output_lang`/`voice_id`/`clone_ref`→`TtsOptions` 透传给 STT/TTS;语种不支持经既有能力门 fail-fast;**未配置时 STT 不传 language、synthesize opts=undefined、行为逐字不变**。
- `prompt-assembly`: 新增 `OutputLanguageContributor` 要求——`PromptContext.outputLang` 非空时注入一句温和"用<目标语种>回复"(priority 可配),为空返回 `null`;`Conversation` 构造期注册进 assembler、经 `outputLang` 依赖透传;**缺省(无 outputLang)恒返回 null、系统提示逐字不变**。
