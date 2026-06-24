## ADDED Requirements

### Requirement: voice 配置块解析为 VoiceProfile

系统 SHALL 提供 voice 配置块加载器 `loadVoiceProfile(env)`(providers),把环境变量解析为 `VoiceProfile { inputLang?, outputLang?, voiceId?, cloneRef? }`(承 §4.1 输入/输出语种解绑、用户配置)。来源:`CHAT_A_VOICE_INPUT_LANG`(`auto`|语种码,缺省/`auto`=自动检测)/ `CHAT_A_VOICE_OUTPUT_LANG`(缺省空=不强制)/ `CHAT_A_VOICE_ID` / `CHAT_A_VOICE_CLONE_REF`(refAudio 路径)+ `CHAT_A_VOICE_CLONE_REF_TEXT` / `CHAT_A_VOICE_CLONE_REF_LANG`。`input_lang` 取 `auto`(大小写不敏感)或空时 `inputLang` SHALL **省略键**(自动检测);`output_lang` 空时 `outputLang` SHALL **省略键**。`cloneRef` SHALL 仅在 `CHAT_A_VOICE_CLONE_REF` 非空时产出。各未设字段 MUST 省略键(exactOptionalPropertyTypes,绝不显式 `undefined`)。阈值/默认 MUST 外置(行为即配置,§3.2),无 magic number。

#### Scenario: 全空 env → 空 profile

- **WHEN** 所有 `CHAT_A_VOICE_*` 均未设置
- **THEN** `loadVoiceProfile` 返回的 `VoiceProfile` 各键均缺席(`inputLang`/`outputLang`/`voiceId`/`cloneRef` 全省略)

#### Scenario: input_lang=auto 等价自动检测

- **WHEN** `CHAT_A_VOICE_INPUT_LANG=auto`(或空)
- **THEN** `VoiceProfile.inputLang` 缺席(键省略)

#### Scenario: 配置语种与音色复刻

- **WHEN** `CHAT_A_VOICE_INPUT_LANG=en`、`CHAT_A_VOICE_OUTPUT_LANG=zh`、`CHAT_A_VOICE_ID=xiaoxue_v2`、`CHAT_A_VOICE_CLONE_REF=/path/ref.wav`、`CHAT_A_VOICE_CLONE_REF_TEXT=你好`、`CHAT_A_VOICE_CLONE_REF_LANG=zh`
- **THEN** `VoiceProfile` 为 `{ inputLang:'en', outputLang:'zh', voiceId:'xiaoxue_v2', cloneRef:{ source:'/path/ref.wav', refText:'你好', refLang:'zh' } }`

### Requirement: VoiceLoop 经注入透传输入/输出语种与音色

`VoiceLoop` SHALL 经注入(`VoiceLoopDeps.sttLanguage?: string` 与 `ttsOptions?: TtsOptions`,**不直接 import providers config**,§3.1)把语种/音色透传给 STT/TTS:转写处在 `sttLanguage` 提供时以 `SttOptions.language` 传给 `transcribe`;合成处在 `ttsOptions` 提供时把它传给 `synthesize`(`output_lang`→`language`、`voice_id`→`voiceId`、`clone_ref`→`refAudio`)。**当二者均未注入时**,`transcribe` MUST NOT 传 `opts.language`(自动检测)且 `synthesize` 的 opts MUST 为 `undefined`——调用形状与未引入本接线时**字面等价**(逐字现状)。语种不支持时 SHALL 经既有能力门(`assertSttLanguage`/`assertTtsLanguage`,§4.3)在 provider 内 fail-fast,VoiceLoop 既有 try/catch 降级不崩(§3.2)。

#### Scenario: 注入 input_lang → STT 收到 language

- **WHEN** 注入 `sttLanguage='en'`,VoiceLoop 转写一段音频
- **THEN** `stt.transcribe` 收到的 `opts.language === 'en'`

#### Scenario: 注入 output_lang/voice_id/clone_ref → synthesize 收到对应 opts

- **WHEN** 注入 `ttsOptions={ language:'zh', voiceId:'xiaoxue_v2', refAudio:{ source:'/r.wav' } }`,VoiceLoop 合成一句
- **THEN** `tts.synthesize` 收到的 opts 含 `language:'zh'`、`voiceId:'xiaoxue_v2'`、`refAudio.source:'/r.wav'`

#### Scenario: 未注入 → 调用形状逐字现状(回归绿)

- **WHEN** 未注入 `sttLanguage` 与 `ttsOptions`
- **THEN** `transcribe` 调用不带 `opts.language`(自动检测)、`synthesize` 的 opts 为 `undefined`,行为与未引入本接线时逐字一致

#### Scenario: 语种不支持 fail-fast 不崩

- **WHEN** 注入了 provider 能力集不含的语种(如 STT `languages=['zh']` 但 `sttLanguage='ja'`)
- **THEN** provider 经 `assertSttLanguage` 抛清晰错误,VoiceLoop 捕获并降级回 listening,绝不崩(§3.2)

### Requirement: cli 按 voice profile 装配且缺省关回归绿

cli SHALL 在语音模式按 `loadVoiceProfile(env)` 装配:把 `inputLang` 透传为 VoiceLoop 的 `sttLanguage`、由 `outputLang`/`voiceId`/`cloneRef` 拼 `ttsOptions` 透传给 VoiceLoop;并把 `outputLang` 注入 `Conversation`(使文字路也按输出语种回复)。各项 SHALL 仅在 profile 对应键存在时透传(`exactOptionalPropertyTypes` 友好)。当 voice profile 各键缺席(env 全空)时,cli MUST NOT 透传任何语种/音色,**全链路行为与未引入本接线时逐字一致**(缺省安全)。

#### Scenario: 缺省全空 → 全链路不变

- **WHEN** 未设置任何 `CHAT_A_VOICE_*`(且无 card voice 段)
- **THEN** cli 不透传 `sttLanguage`/`ttsOptions`/`outputLang`,STT 自动检测、synthesize opts=undefined、系统提示无输出语种段,行为逐字一致
