# 设计:gpt-sovits-engine

## 背景与约束

- 权威设计 `docs/chat-a-canonical-design.md` §4.1(STT/TTS 语种解绑 + 音色复刻 v2.1)、§4.3(可换性 + 能力门)。
- 接缝/配置已就位(只读、不改):`TtsProvider`/`TtsCapabilities{voiceCloning}`/`TtsRefAudio{source,refText,refLang}`/`TtsOptions{language,voiceId,refAudio,speed}`、`assertTtsLanguage`/`assertTtsCloning`(`tts.ts`);`GptSovitsTtsConfig`(`tts-config.ts`)。
- 开发 5 原则:可测试性(fetch 可注入、mock 不触网)、优雅降级(失败抛清晰中文错供上层)、延迟预算(流式产出首块即可播)、行为即配置、数据迁移纪律(无持久结构变更)。

## 一、GPT-SoVITS API 调研

> ⚠️ **以所部署的 GPT-SoVITS 版本为准**。下述基于官方 `api_v2.py`(RVC-Boss/GPT-SoVITS,`/tts` 端点)与 Open-LLM-VTuber 的 `gpt_sovits_tts.py` 佐证;不同分支/版本字段可能微调,真机以实际部署文档校准。

### 1.1 端点与请求

- **`POST {baseURL}/tts`**,`Content-Type: application/json`,JSON body。默认 `baseURL=http://127.0.0.1:9880`。
- 请求体字段(本实现使用的):
  - `text`(必填):待合成文本。
  - `text_lang`(必填):目标语种(`'zh'`/`'en'`/`'ja'`/`'auto'` 等)。← 取 `opts.language ?? config.textLang`。
  - `ref_audio_path`(必填):参考音频**本地路径**(GPT-SoVITS 服务进程可访问)。← 取 `opts.refAudio.source ?? config.refAudioPath`。
  - `prompt_text`(可选但强烈建议):参考音频转写文本,提升复刻保真。← 取 `opts.refAudio.refText ?? config.promptText`。
  - `prompt_lang`(prompt_text 给定时必填):参考音频语种。← 取 `opts.refAudio.refLang ?? config.promptLang`。
  - `text_split_method`(可选,如 `'cut5'`):长文本切分。← `config.textSplitMethod`。
  - `media_type`(本实现固定 `'raw'`):返回**裸 PCM**(无 WAV 头),便于按 Int16 边界直流式切块;`'wav'` 会带 44 字节头需剥离,故选 `raw`。
  - `streaming_mode`(布尔,本实现取 `config.stream ?? true`):`true` = 分块流式返回。
  - 其余采样参数(`batch_size`/`top_k`/`top_p`/`temperature`/`fragment_interval`/`aux_ref_audio_paths` 等)本期**不暴露**,走服务端默认;后续按需加(纯加法)。
- `media_type=raw` 时 `source` 必须是字符串路径;若 `TtsRefAudio.source` 是内联 `PcmChunk`(本期不支持落盘),fail-fast 抛中文错(留作后续扩展)。

### 1.2 响应

- `streaming_mode=true` + `media_type=raw`:HTTP 200,`Transfer-Encoding: chunked`,body 为连续**裸 PCM(s16le,mono)**。采样率随模型——GPT-SoVITS v2 常见 **32000Hz**(故 config `sampleRate` 默认 32000;按部署实际设),v1/部分模型为 24000。**采样率不在响应里自描述**,以 `config.sampleRate` 为准并写入每个 `PcmChunk`。
- 错误:非 2xx,body 多为 JSON `{"message": "...", "exception": "..."}`(如 400 参数校验失败 / 500 推理异常)。本实现读 body 文本片段拼进中文错误信息(截断 500 字)。

### 1.3 与现有 PCM 解码对齐

- 沿用 `openai-compat-tts.ts` / `qwen-tts-realtime.ts` 的 **carry 半样本进位**:逐块累计字节,按偶数长度(Int16 边界=2 字节)切出 `PcmChunk`,奇数残留字节进位到下一块,杜绝半样本。
- 采样率写 `config.sampleRate`(默认 32000),`channels=1`。

## 二、能力门 / 复刻参数映射

| TtsOptions / config | GPT-SoVITS body | 能力门 |
|---|---|---|
| `opts.language ?? config.textLang ?? 'auto'` | `text_lang` | `assertTtsLanguage(cap, opts.language)` 先行;语种不在 `cap.languages`(且非 `'*'`)→ fail-fast |
| `opts.refAudio.source ?? config.refAudioPath` | `ref_audio_path` | `assertTtsCloning(cap, opts)`:`opts.refAudio` 存在而 `voiceCloning!==true` → fail-fast(本引擎 `voiceCloning=true`,放行) |
| `opts.refAudio.refText ?? config.promptText` | `prompt_text` | — |
| `opts.refAudio.refLang ?? config.promptLang` | `prompt_lang` | — |

- 既不给 `opts.refAudio` 也无 `config.refAudioPath` → fail-fast(GPT-SoVITS `/tts` 必须有参考音频)。明确中文错提示「请配置 refAudioPath 或传 opts.refAudio」。
- `cap.voiceCloning=true`:`assertTtsCloning` 放行带 `refAudio` 的请求(与 OpenAiCompat/qwen 的 `false` 相反,正是本引擎的核心价值)。

## 三、可测试性接缝:fetch 注入(R1)

- `GptSoVitsTtsOptions.fetch?: FetchLike`,缺省 `globalThis.fetch`。`FetchLike` 取最小面(`(url, init) => Promise<Response>`),不把 DOM 类型泄漏到接口。
- `TtsPorts` 新增 `fetch?`(镜像 `kokoroSession`/`qwenWsFactory` 的注入端口),`createTts` 透传给 `GptSoVitsTts`。
- 测试用脚本化 mock fetch 返回带 `ReadableStream` body 的假 `Response`,断言:正常流式产 `PcmChunk`、复刻参数进请求体、能力门、AbortSignal、HTTP 错误降级、半样本进位、registry 装配——**全程不触网**。

## 四、AbortSignal

- `synthesize` 进入即查 `signal.aborted` → 早退空产出(与 qwen 一致)。
- `signal` 透传 `fetch(url, { signal })`:取消时 fetch reject `AbortError`,流读取中断;迭代干净结束(`AbortError` 视为正常取消,不当作引擎错误抛出——与上层 barge-in 语义一致)。

## 五、边界 / 决策

- **不改 `tts-config.ts`**:`GptSovitsTtsConfig` 字段已全(baseURL/textLang/refAudioPath/promptText/promptLang/textSplitMethod/stream/sampleRate/voiceId/device/computeType/requiresCuda/languages)。本期未发现缺字段;若真机校准发现需新增(如 `batchSize`/采样参数),由主控在 `tts-config.ts` 加(纯加法),本引擎再读取。
- `requiresCuda`:GPT-SoVITS 本地推理常需 GPU;能力位按 `config.requiresCuda` 透传(缺省不声明),供 §4.3 能力门/树莓派部署排除。
- model id / 端点:不写死,全走 config。
