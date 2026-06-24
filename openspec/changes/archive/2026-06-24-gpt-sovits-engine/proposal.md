# gpt-sovits-engine

## Why

TTS 音色复刻(§4.1 / v2.1)是「小雪」长期伴侣感的关键能力——同一把声音贯穿始终。接缝(`TtsProvider` + `TtsCapabilities.voiceCloning` + `TtsRefAudio` + 能力门 `assertTtsCloning`/`assertTtsLanguage`)与配置(`GptSovitsTtsConfig`)早已就位,但 `tts-registry.ts` 的 `'gpt-sovits'` 分支仍是 `throw new Error('...尚未接入真实引擎...')` 桩。本变更把它做成**真引擎**:接入 GPT-SoVITS(zero-shot voice cloning)的 HTTP API,让「换引擎 = 换实现 + 改配置,链路不动」(§4.3)在复刻引擎上真正成立。

## What Changes

- 新增 `GptSoVitsTts implements TtsProvider`(`packages/providers/src/gpt-sovits-tts.ts`):
  - 能力声明 `voiceCloning=true` / `streaming=true`;`sampleRate`(默认 32000,GPT-SoVITS 常见)/ `languages` / `voiceId` / `requiresCuda` 按 config 透传。
  - `synthesize(text, opts, signal)`:能力门 `assertTtsLanguage` + `assertTtsCloning` **先行**;构造 GPT-SoVITS `/tts` HTTP 请求(`text`/`text_lang`/`ref_audio_path`/`prompt_text`/`prompt_lang`/`text_split_method`/`streaming_mode`/`media_type`);流式解码裸 PCM(Int16,carry 半样本进位)→ `PcmChunk`;`AbortSignal` 透传 `fetch`;失败抛**清晰中文错误**(优雅降级供上层)。
  - **fetch 可注入**(选项 `fetch?` + 缺省 `globalThis.fetch`),测试 mock 不触网。
- `tts-registry.ts`:`'gpt-sovits'` 分支从 throw 桩 → `new GptSoVitsTts(cfg, ports)`;`TtsPorts` 新增可选 `fetch?` 注入端口(镜像 `qwenWsFactory`)。
- `index.ts`:导出 `./gpt-sovits-tts`。
- 既有 `tts.test.ts` 的 `gpt-sovits` 断言:从「throw 尚未接入」改为「返回 `GptSoVitsTts` 实例」;`listTtsKinds` 保持不变(gpt-sovits 仍在表)。

**不改** `tts-config.ts`(`GptSovitsTtsConfig` 字段已全;另有并行变更在调整其语种字段)。**不碰** voice-loop / cognition / cli / memory / persona。

## Impact

- Affected specs: `tts-engine`(新增能力)
- Affected code:
  - 新增 `packages/providers/src/gpt-sovits-tts.ts`
  - 修改 `packages/providers/src/tts-registry.ts`(gpt-sovits 分支 + `TtsPorts.fetch?`)
  - 修改 `packages/providers/src/index.ts`(导出)
  - 新增 `packages/providers/test/gpt-sovits-tts.test.ts`
  - 修改 `packages/providers/test/tts.test.ts`(gpt-sovits 断言)
- 真机待验证:需用户本地跑 GPT-SoVITS api_v2 服务(默认 `http://127.0.0.1:9880`)或指向部署 endpoint;单测全程 mock fetch 不触网。
