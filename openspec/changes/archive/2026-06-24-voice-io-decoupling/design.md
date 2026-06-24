# Design: voice-io-decoupling(§4.1 语音 I/O 输入/输出语种解绑接线)

## 背景与约束

- 接缝已就位(见 proposal「Why」),缺的是**把配置透传进 STT/TTS/LLM 三处**。
- **硬约束**:不配置 voice 语种时**逐字不变**——`#transcribe` 仍 `transcribe(toChunks())`(无 opts)、`#speak` 仍 `synthesize(sentence, undefined, signal)`、系统提示不含输出语种段。
- **§3.1 接缝边界**:VoiceLoop 在 runtime,**不得 import** `@chat-a/providers` 的 config(它只 `import type { TtsOptions }`,类型而非 config 加载器)。voice 配置的**加载/解析**放 providers(`voice-profile.ts`),VoiceLoop 经**注入**拿到解析好的值。

## 决策

### D1 — voice 配置块放 providers,产出 `VoiceProfile`(纯解析,无副作用)

新增 `packages/providers/src/voice-profile.ts`:

```ts
export interface VoiceCloneRef {
  readonly source: string;   // refAudio 路径(CHAT_A_VOICE_CLONE_REF)
  readonly refText?: string;
  readonly refLang?: string;
}
export interface VoiceProfile {
  readonly inputLang?: string;   // 省略 = auto(STT 不下发 language)
  readonly outputLang?: string;  // 省略 = 不强制(LLM 无注入 + TTS 不下发)
  readonly voiceId?: string;
  readonly cloneRef?: VoiceCloneRef;
}
export function loadVoiceProfile(env): VoiceProfile;
```

- **`exactOptionalPropertyTypes` 纪律**:不设的键一律**省略**(绝不显式 `undefined`),与 stt-config/tts-config 一致。
- `CHAT_A_VOICE_INPUT_LANG` 取值 `auto`(大小写不敏感)/ 空 → `inputLang` 省略;否则填该语种码。
- `CHAT_A_VOICE_OUTPUT_LANG` 空 → `outputLang` 省略。
- `cloneRef` 仅当 `CHAT_A_VOICE_CLONE_REF`(refAudio 路径)非空时才产出;`refText`/`refLang` 各自可选。
- **理由**:放 providers 因为语种/音色概念属于 STT/TTS provider 域(与 stt-config/tts-config 同位);`TtsOptions` 类型也在此包,装配层可直接 `loadVoiceProfile` → 拼 `TtsOptions`。VoiceLoop 只吃注入值,接缝边界不破。

### D2 — VoiceLoop 经注入透传(两个可选 deps,不依赖 providers config)

`VoiceLoopDeps` 新增:

```ts
/** STT 输入语种(§4.1);省略 = 自动检测(transcribe 不传 opts.language,逐字现状)。 */
readonly sttLanguage?: string;
/** TTS 合成 opts(§4.1):output_lang→language、voice_id→voiceId、clone_ref→refAudio。
 *  省略 = synthesize opts 仍为 undefined(逐字现状)。 */
readonly ttsOptions?: TtsOptions;
```

- `#transcribe(buf)`:
  - 现状:`this.#stt.transcribe(toChunks())`。
  - 改后:`const opts = this.#sttLanguage !== undefined ? { language: this.#sttLanguage } : undefined; this.#stt.transcribe(toChunks(), opts)`。`opts === undefined` 时调用形状与现状**字面等价**。
- `#speak(sentence, gen, signal)`:
  - 现状:`this.#tts.synthesize(sentence, undefined, signal)`。
  - 改后:`this.#tts.synthesize(sentence, this.#ttsOptions, signal)`。`#ttsOptions === undefined`(缺省)时与现状字面等价。
- **omni 直路不涉及**:omni 不走 STT/TTS synthesize(audio-in 直路自带语种处理),本期不动 `#startThinkingOmni`(但 omni 路的 TTS 合成同样经 `#speak`,故 `ttsOptions` 对 omni 的 TTS 输出也自然生效——纯加法、无特殊分支)。
- **类型**:VoiceLoop 已 `import type { ... } from '@chat-a/providers'`,补 `TtsOptions` 到该 type import(纯类型,不引 config)。

### D3 — `OutputLanguageContributor`(cognition,§5.4 PromptContributor)

新增 `OutputLanguageContributor`:

```ts
export class OutputLanguageContributor implements PromptContributor {
  contribute(ctx: PromptContext): PromptFragment | null {
    const lang = ctx.outputLang?.trim();
    if (lang === undefined || lang.length === 0) return null; // 缺省零注入
    return {
      text: `[回复语种]\n无论用户用什么语言,你都用「${lang}」回复。`,
      priority: PROMPT_PRIORITY.outputLanguage,
      tier: 'peripheral',
    };
  }
}
```

- `PromptContext` 新增 `readonly outputLang?: string`。
- `PROMPT_PRIORITY.outputLanguage`:放**高注意力区**(贴近末尾,确保语种指令不被长对话稀释),取 `935`(在 `style`=920 与 `dissent`=950 之间——语种是硬约束、比风格更想被遵守,但仍让立场/反谄媚压轴)。带间隙、外置可配,无 magic number。
- `tier:'peripheral'`:极端预算下可裁(核心事实/记忆优先),与其他行为项一致。
- **措辞温和但明确**:不强加道德、只指示语种;为空恒返回 null → **默认系统提示逐字不变**。

### D4 — Conversation 注册 + `outputLang` 透传(runtime)

- `ConversationDeps` + `TurnDeps` 新增可选 `outputLang?: string`(仅在提供时填,`exactOptionalPropertyTypes` 友好)。
- 构造期 `PromptAssembler` 注册 `OutputLanguageContributor()`(追加在 `StyleDisciplineContributor` 之后即可,priority 已定序);无 `outputLang` 时它恒返回 null → **默认路径零注入**。
- `composeSystem` 新增可选 `outputLang?` 入参,填进 `assembler.assemble({ …, outputLang })`;缺省不填(等价现状)。
- `SingleShotStrategy.run` / `ToolCallingStrategy`:把 `deps.outputLang` 透传进 `composeSystem`(两策略共用 turn-shared,零漂移)。
- `composeOmniInstructions` 也透传 `deps.outputLang`(omni 路系统提示同样按输出语种,纯加法)。

### D5 — cli 装配(client)

- `cli-voice.ts` `VoiceModeDeps` 新增可选 `sttLanguage?` / `ttsOptions?`;`startVoiceMode` 把它们透传进 `runVoiceLoop` 的 `loopDeps`(仅在提供时填)。
- `cli.ts`:`loadVoiceProfile(env)` → 由 profile 拼 `sttLanguage`(=`inputLang`)+ `ttsOptions`(`language=outputLang`,`voiceId`,`refAudio` 从 cloneRef);仅在 voice 模式且 profile 有对应键时透传。`Conversation` 注入 `outputLang`(= profile.outputLang)使**文字路也按输出语种回复**(语种解耦不限语音)。
- 可选:persona card `voice:` 段解析(card-loader 已是纯 YAML 映射;cli 装配层读 card 的 `voice` 字段叠加到 env profile,env 优先 / card 兜底)。**本期以 env 为主**,card voice 段作为可选增强(若实现则纯加法、缺省不变)。
- 缺省(env 全空)→ profile 各键缺席 → 不透传 → 全链路逐字现状。

### D6 — 能力门 fail-fast(§4.3,复用既有)

- 语种校验**已在各 provider 的 transcribe/synthesize 入口**调 `assertSttLanguage`/`assertTtsLanguage`(见 fake-stt/fake-tts)。VoiceLoop 透传不支持语种时,provider 抛清晰错误 → VoiceLoop 既有 try/catch 捕获(`#transcribe` 抛错降级回 listening、`#speak` 抛错跳过本句),不崩。
- **不在 VoiceLoop 额外加断言**(避免重复 + 保持 VoiceLoop 不依赖 capabilities 细节);能力门职责留 provider。
- 多 provider 按语种自动切换/路由 = **future**(注释标注),本 change 不做。

## 风险与回归

- **唯一回归风险点**:`#transcribe`/`#speak` 调用形状改变。缓解:缺省值 `undefined` 时传参字面等价现状(`transcribe(toChunks(), undefined)` ≡ `transcribe(toChunks())`;`synthesize(s, undefined, signal)` 不变),既有 voice-loop 测试不受影响。
- **contributor 注册风险**:新增一个恒返回 null(无 outputLang)的 contributor,assembler 跳过 null fragment,系统提示字节不变 → KV 前缀稳定。
- 全程 Fake + 注入端口单测,不触网。
