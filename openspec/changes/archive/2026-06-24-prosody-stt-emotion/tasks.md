## 1. STT 返回类型纯加法扩展(providers)

- [x] 1.1 `stt.ts`:新增 `SttEmotionLabel`(surprised/neutral/happy/sad/disgusted/angry/fearful)与 `SttEmotion`(label + 可选 confidence);`SttResult` 加**可选** `emotion?: SttEmotion`(纯加法,带注释说明既有 provider 恒不设)
- [x] 1.2 确认既有 `FakeStt`/`OpenAiCompatStt`/`WhisperLocalStt` 不设 emotion 键(行为字面不变,exactOptionalPropertyTypes 合规)

## 2. Provider:QwenAsrStt(注入式 fetch 端口,批式 chat/completions + 情绪解析)

- [x] 2.1 定义注入端口 `SttFetch`(`(url, init) => Promise<{ ok; status; statusText; json(); text() }>`,最小面、不泄漏 DOM 类型);缺省工厂用全局 `fetch`
- [x] 2.2 `QwenAsrStt implements SttProvider`:构造吃 id/model/apiKey/baseURL/language/enableItn/languages + 可选 fetch;apiKey 缺失/空 → 构造 fail-fast(提示 `CHAT_A_DASHSCOPE_API_KEY`)
- [x] 2.3 能力声明:`languages`(默认 `['*']`,26 语种多语种)/ `streaming:false`(批式)/ `sampleRate:16000`
- [x] 2.4 `transcribe`:`assertSttLanguage` 先行;聚合 PcmChunk 流 → WAV(复用 WAV 编码,与 openai-compat-stt 同范式)→ base64 Data URL;POST `{baseURL}/chat/completions` JSON body(model + messages[input_audio] + asr_options{language,enable_itn});`buildRequestBody()` 抽成可改内部函数(协议歧义可控)
- [x] 2.5 解析:文本 `choices[0].message.content`;情绪 `choices[0].message.annotations[]` 取首条带 `emotion` 的标注 → 映射 `SttResult.emotion`;**无 annotations/无 emotion → 不设 emotion 键**(纯加法);language 取 annotation.language 或回落 opts.language;只 yield 一条 `isFinal:true`
- [x] 2.6 优雅降级:HTTP 非 2xx → 抛带 status/正文片段中文 Error(**不含 key**);emotion 标签非法值 → 忽略 emotion(不抛、不污染)
- [x] 2.7 AbortSignal:透传给 fetch(`init.signal`);进入即 aborted → 不发请求空产出

## 3. 配置与注册(providers)

- [x] 3.1 `stt-config.ts`:加判别联合分支 `QwenAsrSttConfig`(`kind:'qwen-asr'`:id/model/apiKey/baseURL/language/enableItn/languages);`loadSttConfig` 支持 `CHAT_A_STT_KIND=qwen-asr`(model/baseURL 内置默认,apiKey 回落 `CHAT_A_DASHSCOPE_API_KEY`,language/CHAT_A_STT_ENABLE_ITN);**保留既有 `kind=qwen` 便捷档不变**
- [x] 3.2 `stt-registry.ts`:`SttPorts` 加可选 `fetch`;登记 `'qwen-asr'` 工厂(透传配置 + fetch 端口);`createStt` 核心零改动
- [x] 3.3 `index.ts`:导出 `QwenAsrStt` 与相关类型(`SttFetch`/`SttEmotion`/`SttEmotionLabel` 经 stt.ts 已 export *)

## 4. persona:prosodyToPadPull(确定性内核)

- [x] 4.1 `packages/persona/src/prosody.ts`:`SttEmotionLike`(结构类型,不依赖 providers 包)+ 外置 `DEFAULT_PROSODY_PAD_MAP`(7 类 → PadPull,见 design §3)
- [x] 4.2 `prosodyToPadPull(emotion?, map?)`:纯函数;label 命中表 → 拉力(confidence∈(0,1] 时线性缩放);undefined/未知/neutral → 零拉力;结果 `clampUnit` 钳制
- [x] 4.3 `persona/src/index.ts`:导出 `prosody`

## 5. 测试(注入假 fetch,不触网 + golden)

- [x] 5.1 `qwen-asr-stt.test.ts`:注入假 fetch 返回罐装 chat/completions JSON → 断言解析出 text + `emotion.label`(如 'sad');annotations 缺失/空 → 结果**不含 emotion 键**
- [x] 5.2 `qwen-asr-stt.test.ts`:缺 key 构造 fail-fast;限定语种 + 外语种 → fail-fast;HTTP 500 → 抛中文错误(不含 key);非法 emotion 值被忽略
- [x] 5.3 `qwen-asr-stt.test.ts`:请求体形态(POST /chat/completions,body 含 model + messages[input_audio data:audio/wav;base64] + asr_options.language)
- [x] 5.4 `stt.test.ts` 回归追加:`listSttKinds()` 含 `'qwen-asr'`;`loadSttConfig({CHAT_A_STT_KIND:'qwen-asr', CHAT_A_DASHSCOPE_API_KEY:'k'})` 解析正确;既有 fake/openai-compat/whisper-local/qwen 断言**全绿不动**
- [x] 5.5 `prosody.test.ts`:7 类标签 golden(逐条钉 PadPull);undefined/未知/neutral → 零拉力;confidence 缩放;两次同入参全等(确定性)

## 6. 验证

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿(新分支/新类型不级联破坏其它包)
- [x] 6.2 worktree 根 `npx vitest run` 全绿:新测试通过 + 既有 STT/persona 回归不破
- [x] 6.3 自检与 canonical 一致(§7#5 / §6.1 / §4.1/§4.3 / §3.2 / §8.1);确认只改 `packages/providers/**` + `packages/persona/**`,未碰 voice-loop/cli/runtime/cognition/memory
