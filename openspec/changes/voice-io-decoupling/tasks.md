# Tasks: voice-io-decoupling

## 1. voice 配置块(providers)

- [x] 1.1 `packages/providers/src/voice-profile.ts`(新增):导出 `VoiceCloneRef { source, refText?, refLang? }` + `VoiceProfile { inputLang?, outputLang?, voiceId?, cloneRef? }` + `loadVoiceProfile(env = process.env): VoiceProfile`。env 来源见 design D1;`input_lang=auto`(大小写不敏感)/空 → `inputLang` 省略;`output_lang` 空 → `outputLang` 省略;`cloneRef` 仅 `CHAT_A_VOICE_CLONE_REF` 非空时产出。各未设字段**省略键**(exactOptionalPropertyTypes)。
- [x] 1.2 `packages/providers/src/index.ts`:`export * from './voice-profile'`。

## 2. voice-loop 透传(runtime)

- [x] 2.1 `packages/runtime/src/voice-loop.ts`:type import 补 `TtsOptions`(`import type { ..., TtsOptions } from '@chat-a/providers'`,纯类型,不引 config)。
- [x] 2.2 `VoiceLoopDeps` 新增可选 `sttLanguage?: string` + `ttsOptions?: TtsOptions`(带注释:省略=自动检测 / synthesize opts 仍 undefined,逐字现状);构造期存到私有 `#sttLanguage` / `#ttsOptions`。
- [x] 2.3 `#transcribe(buf)`:`const opts = this.#sttLanguage !== undefined ? { language: this.#sttLanguage } : undefined; this.#stt.transcribe(toChunks(), opts)`。`opts===undefined` 时与现状 `transcribe(toChunks())` 字面等价。
- [x] 2.4 `#speak(sentence, gen, signal)`:`this.#tts.synthesize(sentence, this.#ttsOptions, signal)`(`#ttsOptions` 缺省 undefined 时等价现状)。

## 3. LLM 输出语种注入(cognition)

- [x] 3.1 `packages/cognition/src/prompt/types.ts`:`PromptContext` 新增 `readonly outputLang?: string`(注释:§4.1 输出语种;缺省=不强制=OutputLanguageContributor 返回 null)。
- [x] 3.2 `packages/cognition/src/prompt/config.ts`:`PROMPT_PRIORITY` 新增 `outputLanguage: 935`(在 style=920 与 dissent=950 之间,带注释)。
- [x] 3.3 `packages/cognition/src/prompt/contributors.ts`:新增 `OutputLanguageContributor`——`ctx.outputLang?.trim()` 非空时返回 `{ text:'[回复语种]\n无论用户用什么语言,你都用「<lang>」回复。', priority:PROMPT_PRIORITY.outputLanguage, tier:'peripheral' }`;为空/缺省返回 null。
- [x] 3.4 `packages/cognition/src/prompt/index.ts`:已 `export * from './contributors'`,确认 `OutputLanguageContributor` 导出(无需改,验证即可)。

## 4. Conversation 注册 + outputLang 透传(runtime)

- [x] 4.1 `packages/runtime/src/conversation.ts`:`import { ..., OutputLanguageContributor }`;`ConversationDeps` + `TurnDeps` 新增可选 `outputLang?: string`(注释 + 仅提供时填)。
- [x] 4.2 `conversation.ts` 构造期:`PromptAssembler` 注册 `new OutputLanguageContributor()`(追加在 `StyleDisciplineContributor` 之后);装配 `TurnDeps` 时 `...(deps.outputLang ? { outputLang: deps.outputLang } : {})`。
- [x] 4.3 `packages/runtime/src/turn-shared.ts`:`composeSystem` 新增可选 `outputLang?: string` 入参,填进 `assembler.assemble({ …, ...(outputLang ? { outputLang } : {}) })`。
- [x] 4.4 `conversation.ts` `SingleShotStrategy.run`:把 `deps.outputLang` 透传进 `composeSystem`(在现有调用追加参数)。`composeOmniInstructions` 同样透传 `deps.outputLang`。
- [x] 4.5 `tool-calling-strategy.ts`(若它也调 `composeSystem`):同样透传 `deps.outputLang`(两策略零漂移)。

## 5. cli 装配(client)

- [x] 5.1 `packages/client/src/cli-voice.ts`:`VoiceModeDeps` 新增可选 `sttLanguage?: string` + `ttsOptions?: import('@chat-a/providers').TtsOptions`;`startVoiceMode` 把它们仅在提供时透传进 `runVoiceLoop` 的 `loopDeps`。
- [x] 5.2 `packages/client/src/cli.ts`:`loadVoiceProfile(env)`;voice 模式时由 profile 拼 `sttLanguage=inputLang`、`ttsOptions`(`language=outputLang`、`voiceId`、`refAudio` 从 cloneRef),仅在对应键存在时透传进 `startVoiceMode`。
- [x] 5.3 `cli.ts` `makeConvo`:注入 `...(voiceProfile.outputLang ? { outputLang: voiceProfile.outputLang } : {})`(文字路也按输出语种回复)。
- [ ] 5.4(可选,纯加法,**本期未做,标 future**)persona card `voice:` 段:cli 读 card 的 `voice` 字段叠加到 env profile(env 优先);缺省不变。本 change 以 env(`CHAT_A_VOICE_*`)为唯一来源;card `voice:` 段留作后续增强(`loadVoiceProfile` 接缝已就位,叠加 card 来源时纯加法、缺省不变)。

## 6. 测试(全部不触网、注入端口)

- [x] 6.1 `packages/providers/test/voice-profile.test.ts`(新增):env 全空→各键缺席;`auto`/空→inputLang 缺席;完整 env→全字段(含 cloneRef)。
- [x] 6.2 `packages/runtime/test/voice-io-decoupling.test.ts`(新增):FakeStt/FakeTts(spy opts)+ 注入——
  - `sttLanguage='en'` → `transcribe` 收到 `opts.language==='en'`。
  - `ttsOptions={language,voiceId,refAudio}` → `synthesize` 收到对应 opts(refAudio 经 FakeTts 复刻标记可断言)。
  - **未注入 → `transcribe` 无 opts.language、`synthesize` opts===undefined(回归绿)**。
  - 不支持语种(FakeStt `capabilities.languages=['zh']` + `sttLanguage='ja'`)→ provider fail-fast,VoiceLoop 降级不崩。
- [x] 6.3 `packages/cognition/test/output-language.test.ts`(新增):`outputLang='zh'`→含「zh」段、priority 正确;缺省/空→null。
- [x] 6.4 `packages/runtime/test`(扩充或新增):`Conversation` 注入 `outputLang`→system 含语种段;未注入→不含(回归绿)。

## 7. 验证与收尾

- [x] 7.1 `pnpm -r typecheck` 全绿。
- [x] 7.2 `npx vitest run` 全绿(新增 + 既有全量回归,强调未配置回归绿)。
- [x] 7.3 `openspec validate voice-io-decoupling --strict` 通过。
- [x] 7.4 `git commit`(中文)到当前 worktree 分支,不 push、不动 master。
