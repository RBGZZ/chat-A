## 1. 新建 GptSoVitsTts(packages/providers/src/gpt-sovits-tts.ts)

- [x] 1.1 `FetchLike` 最小面端口 + `GptSoVitsTtsOptions`(id/baseURL/textLang/refAudioPath/promptText/promptLang/textSplitMethod/stream/sampleRate/voiceId/requiresCuda/languages/fetch)
- [x] 1.2 `GptSoVitsTts implements TtsProvider`:`capabilities` 声明 `voiceCloning=true`/`streaming=true`,`sampleRate`(默认 32000)/`languages`(默认 `['*']`)/`voiceId`/`requiresCuda` 透传;`fetch` 缺省 `globalThis.fetch`
- [x] 1.3 `synthesize`:能力门 `assertTtsLanguage` + `assertTtsCloning` 先行;进入即查 `signal.aborted` 早退
- [x] 1.4 参数解析:`text_lang`=opts.language??textLang;`ref_audio_path`=opts.refAudio.source??refAudioPath;`prompt_text`=refText??promptText;`prompt_lang`=refLang??promptLang;无任何参考音频 → fail-fast 中文错;`source` 非字符串(内联 PcmChunk)本期 fail-fast
- [x] 1.5 `POST {baseURL}/tts` JSON body(含 streaming_mode/media_type='raw'/text_split_method);`signal` 透传 fetch
- [x] 1.6 非 2xx / 无 body → 抛带状态码+正文片段清晰中文错;`AbortError` 视为正常取消(不抛引擎错)
- [x] 1.7 流式裸 PCM 按 Int16 边界切 `PcmChunk`(carry 半样本进位,采样率取配置、channels=1)

## 2. registry 接真 + 导出

- [x] 2.1 `tts-registry.ts`:`TtsPorts` 加可选 `fetch?` 注入端口(镜像 qwenWsFactory)
- [x] 2.2 `tts-registry.ts`:`'gpt-sovits'` 分支 throw 桩 → `new GptSoVitsTts({...cfg 字段透传..., ...(ports.fetch?{fetch:ports.fetch}:{})})`
- [x] 2.3 `index.ts`:`export * from './gpt-sovits-tts'`

## 3. 测试(packages/providers/test/gpt-sovits-tts.test.ts,mock fetch 不触网)

- [x] 3.1 正常流式:mock fetch 返回流式裸 PCM → 产对应 `PcmChunk`(采样率/channels/样本)
- [x] 3.2 复刻参数进请求体:opts.refAudio(source/refText/refLang)+ opts.language → body 的 ref_audio_path/prompt_text/prompt_lang/text_lang
- [x] 3.3 config 默认回落:不传 opts.refAudio → body 取 config 的 refAudioPath/promptText/promptLang/textLang
- [x] 3.4 能力门:voiceCloning=true 放行 refAudio;限定语种 + 外语种 → fail-fast(不发请求)
- [x] 3.5 无任何参考音频 → fail-fast 中文错(不发请求)
- [x] 3.6 AbortSignal:进入即已取消 → 空产出不建请求;中途取消 → 停止产出
- [x] 3.7 HTTP 错误降级:非 2xx(含 body)→ 抛含状态码+正文片段中文错
- [x] 3.8 跨块半样本进位:奇数字节块 → 残留进位下一块、不产半样本
- [x] 3.9 registry 装配:`createTts({kind:'gpt-sovits',...}, {fetch})` → `GptSoVitsTts` 且能流式合成

## 4. 改既有测试 + 验收

- [x] 4.1 `tts.test.ts`:`gpt-sovits` 断言从「throw 尚未接入」改为「返回 `GptSoVitsTts` 实例」;`listTtsKinds` 含 gpt-sovits 不变
- [x] 4.2 worktree 根 `pnpm -r typecheck` 全绿
- [x] 4.3 worktree 根 `npx vitest run` 全绿(新增 + 回归)
- [x] 4.4 `openspec validate gpt-sovits-engine --strict` 通过
