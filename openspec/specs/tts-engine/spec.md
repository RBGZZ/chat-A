# tts-engine Specification

## Purpose
TBD - created by archiving change gpt-sovits-engine. Update Purpose after archive.
## Requirements
### Requirement: GPT-SoVITS 复刻引擎实现 TtsProvider 接缝

系统 SHALL 提供 `GptSoVitsTts` 实现 `TtsProvider`,接入 GPT-SoVITS(zero-shot voice cloning)的 HTTP `/tts` 端点,作为音色复刻引擎落地(§4.1 / §4.3)。其 `capabilities` MUST 声明 `voiceCloning=true` 与 `streaming=true`;`sampleRate`/`languages`/`voiceId`/`requiresCuda` MUST 由配置透传(`sampleRate` 缺省按 GPT-SoVITS 常见值,`languages` 缺省 `['*']`)。`id` MUST 仅供 trace/日志,业务层不得据此分支。

#### Scenario: 能力声明含复刻与流式

- **WHEN** 以 `GptSovitsTtsConfig` 构造 `GptSoVitsTts` 并读取 `capabilities`
- **THEN** `voiceCloning` 为 `true`、`streaming` 为 `true`,`sampleRate` 等于配置值(缺省 GPT-SoVITS 常见采样率)

### Requirement: synthesize 构造 GPT-SoVITS 请求并流式产出 PcmChunk

`GptSoVitsTts.synthesize(text, opts, signal)` SHALL 先经能力门 `assertTtsLanguage`(语种)与 `assertTtsCloning`(复刻)fail-fast,再以 `POST {baseURL}/tts` 发起 JSON 请求,请求体 MUST 含 `text`、`text_lang`、`ref_audio_path`、`prompt_text`、`prompt_lang`、`streaming_mode`、`media_type` 等字段。参考音色参数 MUST 以 `opts.refAudio` 优先、`config` 默认(`refAudioPath`/`promptText`/`promptLang`)回落;`text_lang` MUST 以 `opts.language` 优先、`config.textLang` 回落。响应的流式裸 PCM(s16le mono)MUST 按 Int16 边界切成 `PcmChunk`(采样率取配置值、`channels=1`),跨块奇数残留字节 MUST 进位到下一块、不产半样本。

#### Scenario: 正常流式合成产出 PcmChunk

- **WHEN** 注入的 fetch 返回带流式裸 PCM body 的 200 响应
- **THEN** `synthesize` 逐块产出 `PcmChunk`,每块 `sampleRate` 等于配置采样率、`channels` 为 1,样本为 s16le 解码结果

#### Scenario: 复刻参数进入请求体

- **WHEN** `synthesize` 带 `opts.refAudio = { source, refText, refLang }`
- **THEN** 发往 fetch 的请求体 `ref_audio_path`/`prompt_text`/`prompt_lang` 分别取自 `source`/`refText`/`refLang`,`text_lang` 取自 `opts.language`(缺省回落 `config.textLang`)

#### Scenario: 跨块半样本进位

- **WHEN** 流式 body 的某块以奇数字节结束(半个 Int16 样本)
- **THEN** 该残留字节进位到下一块再解码,任一 `PcmChunk` 都不含半样本

### Requirement: GPT-SoVITS 引擎的能力门与缺参 fail-fast

`GptSoVitsTts` SHALL 在建立请求前执行能力门:请求语种不在 `capabilities.languages`(且非 `'*'`)MUST fail-fast;`voiceCloning=true` 故带 `refAudio` 的请求 MUST 放行。当既无 `opts.refAudio` 也无 `config.refAudioPath`(GPT-SoVITS `/tts` 必须有参考音频)时,MUST 抛清晰中文错误且不触发网络请求。

#### Scenario: voiceCloning=true 放行 refAudio

- **WHEN** `synthesize` 带 `opts.refAudio`
- **THEN** `assertTtsCloning` 放行(不抛错),请求照常构造

#### Scenario: 限定语种外语种被拒

- **WHEN** `capabilities.languages` 为 `['zh']` 而 `opts.language` 为 `'en'`
- **THEN** `synthesize` fail-fast 抛「不支持语种」中文错误,不发请求

#### Scenario: 无任何参考音频被拒

- **WHEN** 既未配置 `refAudioPath` 也未传 `opts.refAudio`
- **THEN** `synthesize` 抛清晰中文错误提示需配置参考音频,且未发起 fetch

### Requirement: AbortSignal 取消与错误优雅降级

`GptSoVitsTts.synthesize` SHALL 透传 `AbortSignal` 至 `fetch`:进入即已取消时 MUST 空产出且不发请求;合成中途取消 MUST 干净停止迭代(`AbortError` 视为正常取消、不作为引擎错误抛出)。HTTP 非 2xx 或无响应 body 时 MUST 抛带状态码与正文片段的清晰中文错误,供上层优雅降级。

#### Scenario: 进入即已取消

- **WHEN** 传入已 `abort()` 的 signal
- **THEN** `synthesize` 空产出,且未发起 fetch

#### Scenario: 中途取消干净停止

- **WHEN** 收到首块后 `abort()`
- **THEN** 迭代停止、不再产出,fetch 因 signal 中断

#### Scenario: HTTP 错误降级

- **WHEN** 注入的 fetch 返回非 2xx(如 400/500,body 含错误信息)
- **THEN** `synthesize` 抛含状态码与正文片段的清晰中文错误

### Requirement: createTts 经注入 fetch 端口装配 GPT-SoVITS 引擎

`createTts` SHALL 在 `kind: 'gpt-sovits'` 时返回 `GptSoVitsTts`(由 `GptSovitsTtsConfig` 字段透传),不再抛「尚未接入」桩错误。`TtsPorts` SHALL 提供可选 `fetch?` 注入端口(镜像现有 `kokoroSession`/`qwenWsFactory`),`createTts` MUST 透传给 `GptSoVitsTts`;缺省时引擎用 `globalThis.fetch`。`listTtsKinds()` MUST 仍含 `'gpt-sovits'`。

#### Scenario: 工厂返回真实引擎实例

- **WHEN** `createTts({ kind: 'gpt-sovits', baseURL, textLang, refAudioPath, ... }, { fetch })`
- **THEN** 返回 `GptSoVitsTts` 实例,且其 `synthesize` 经注入的 fetch 流式合成、不触真网络

#### Scenario: gpt-sovits 仍在已注册列表

- **WHEN** 调用 `listTtsKinds()`
- **THEN** 返回的列表含 `'gpt-sovits'`

