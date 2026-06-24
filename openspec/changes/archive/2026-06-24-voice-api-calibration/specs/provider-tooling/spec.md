## ADDED Requirements

### Requirement: qwen-tts-realtime 下发输出语种为 Qwen language_type

`QwenTtsRealtime.synthesize` SHALL 把请求的输出语种(`TtsOptions.language`,项目内部统一 ISO 码)映射为 DashScope qwen-tts-realtime 的 `session.language_type` 取值(合法值为首字母大写英文名:`Auto/Chinese/English/German/Italian/Portuguese/Spanish/Japanese/Korean/French/Russian`),并写入握手 `session.update.session.language_type`,以让「语音 I/O 语种解耦」(§4.1)在 qwen TTS 侧真正生效。

映射 MUST 经具名 helper `toQwenLanguageType` 完成(放 `providers` 内、具名常量、无 magic number):ISO 码(`zh/en/ja/ko/de/it/pt/es/fr/ru`,大小写不敏感)映成对应 Qwen 名;已是合法 Qwen 名则归一原样返回(兼容用户直传)。

**回归硬线**:当 `opts.language` **未给** 或为**未知码**时,`toQwenLanguageType` MUST 返回 undefined,且 `synthesize` MUST NOT 在 `session.update` 中包含 `language_type` 字段(等价服务端默认 `Auto`,与未配置语种前的行为逐字一致)。映射不可识别的语种 MUST NOT 抛错(优雅,落回 Auto)。

#### Scenario: 已配置输出语种 → 下发对应 language_type

- **WHEN** 以 `synthesize(text, { language: 'zh' })` 合成(注入 mock WS)
- **THEN** 握手 `session.update.session.language_type` 等于 `'Chinese'`;同理 `'en'` → `'English'`

#### Scenario: 未配置语种 → 不发 language_type(逐字回归)

- **WHEN** 以 `synthesize(text)`(不带 language)或带未知码(如 `'xx'`)合成
- **THEN** 握手 `session.update` 不含 `language_type` 字段,合成产出与未做本次校准前逐字一致

#### Scenario: toQwenLanguageType 映射契约

- **WHEN** 调用 `toQwenLanguageType`
- **THEN** `'zh'→'Chinese'`、`'en'→'English'`;未给/未知码 → `undefined`;直传合法 Qwen 名(如 `'Chinese'`)→ 原样返回

### Requirement: 声音复刻列表分页与音色 id 兼容解析

千问声音复刻的 **list** 请求 SHALL 携带分页参数(`page_index` 与可配的 `page_size`,默认具名常量,如 100),避免服务端只返首页导致音色漏列;query/delete 不带分页。list 响应解析 SHALL 兼容音色元素 id 出现在 `voice` 或 `voice_id` 两种字段(取 `voice` 失败回退 `voice_id`),以容忍服务端形态差异。

注:create / query / delete 链路(端点、`buildCreateBody`、base64 data URI、`output.voice` 解析、裸动词 `list`/`delete` + `voice` 字段)已据官方核实(2026-06-24)正确,本要求只在其上补分页与元素 id 兼容。CosyVoice 是另一套契约(`list_voice`/`delete_voice` + `voice_id`,语种走注册期 `language_hints`),不可与本路径混用。

#### Scenario: list 请求带分页

- **WHEN** 调用 `listVoices`(注入 mock fetch)
- **THEN** 请求体 `input` 含 `action:'list'` + `page_index:0` + `page_size`(等于配置/默认页大小)

#### Scenario: 列表元素 id 兼容 voice 与 voice_id

- **WHEN** list 响应元素分别为 `{ voice:'a' }` 与 `{ voice_id:'b' }`
- **THEN** `parseVoiceList` 解析得到 `['a','b']`(`voice` 取不到时回退 `voice_id`)

### Requirement: 复刻 target_model 与合成 model 一致性纪律

千问声音复刻得到的音色 SHALL 绑定单一目标模型:创建时的 `target_model` 与后续合成时使用的 model MUST 逐字一致(含日期快照整串),否则合成失败。实现 MUST 支持 `createVoice` 经 `targetModel` 覆盖、合成经 `voiceId` 覆盖,且装配层(desktop)持久化复刻 voiceId 时 MUST 按当前合成 model 选取一致的 `target_model`。

#### Scenario: 装配层据合成 model 推 target_model

- **WHEN** 配置 `CHAT_A_TTS_MODEL` 为某 vc 合成模型,经装配层一键复刻
- **THEN** 复刻 `target_model` 取该合成模型整串(否则回落默认 vc 模型),确保复刻得到的 voiceId 可被同一 model 合成
