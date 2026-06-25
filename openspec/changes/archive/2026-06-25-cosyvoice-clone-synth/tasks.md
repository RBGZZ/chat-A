## 1. DashScope 临时上传(dashscope-file-upload)

- [x] 1.1 新建 `packages/providers/src/dashscope-upload.ts`:`uploadToDashScopeTemp(bytes, filename, {apiKey, model, endpoint?, fetch?})` → `oss://` URL;getPolicy 请求 + OSS multipart POST + 拼 URL,字段隔离在 build 函数,`model` 为可配参数(默认值注释"真机校准")。
- [x] 1.2 纯函数单测(注入 mock fetch):凭证解析、OSS form-data 字段、oss:// 拼接、非2xx/缺字段报错(不含 key)、AbortSignal 取消。
- [x] 1.3 导出 `X-DashScope-OssResourceResolve` 头辅助(oss:// 才加),供复刻模块复用。

## 2. CosyVoice 复刻模块(voice-cloning)

- [x] 2.1 新建 `packages/providers/src/cosyvoice-voice-clone.ts`:常量(端点/voice-enrollment/默认 target_model=cosyvoice-v3.5-flash/轮询间隔+上限)+ build 纯函数(buildCosyCreateBody/buildCosyManageBody/parseCosyVoiceId/parseCosyStatus/parseCosyVoiceList)。
- [x] 2.2 `createCosyVoice(audioOrUrl, opts, signal?)`:本地字节→经 task1 上传得 oss:// URL(或直接收公网 https URL)→ create_voice(oss:// 时带解析头)→ 解析 voice_id。prefix 合法性(≤10 数字字母)发请求前校验。
- [x] 2.3 `queryCosyVoice` + 轮询循环:间隔/上限可配,status OK 成功 / UNDEPLOYED 失败 / 超时报错,AbortSignal 干净中断。
- [x] 2.4 `listCosyVoices`(分页 page_index/page_size + prefix?)、`deleteCosyVoice`(voice_id)。
- [x] 2.5 单测(注入 mock fetch):创建成功、prefix 非法拦截、轮询 OK/UNDEPLOYED/超时/取消、list 分页解析、delete;并断言不触碰 qwen 契约。

## 3. CosyVoiceTts 合成 provider(tts-engine)

- [x] 3.1 WS 小工具:qwen 的 `QwenWsLike`/`QwenWsFactory` 已导出可复用;但 `FrameQueue`/`concat`/`bytesToInt16`/carry/`defaultWsFactory` 是模块私有,**且 qwen FrameQueue 是 base64 字符串型(`#buf:string[]`),CosyVoice 是二进制 `Uint8Array` 帧**——故 queue 不可原样复用,在 cosyvoice-tts 内**同构实现**(s16le 进位逻辑可参照);只把真正通用的小件抽出。
- [x] 3.2 新建 `packages/providers/src/cosyvoice-tts.ts` implements `TtsProvider`:常量(端点 /api-ws/v1/inference、默认 format=pcm/sample_rate=24000)+ build 函数(buildRunTask/buildContinueTask/buildFinishTask)+ 注入式 wsFactory + 注入式 taskId 生成器。
- [x] 3.3 synthesize:握手→run-task(parameters.voice=opts.voiceId、model)→等 task-started→continue-task(input.text)→finish-task;`message` 分发:JSON+header.event=事件、二进制=音频帧拼接产出 PcmChunk;task-finished 收尾、task-failed 透出 error_code/message;AbortSignal 真取消+关连接。
- [x] 3.4 能力门:缺 key fail-fast、无 voiceId 合成给清晰提示(CosyVoice 无系统音色);capabilities `voiceCloning=true`、`voiceId` 列表留空/省略(无系统音色,参 tts.ts 纯 zero-shot 注释),使 assertTtsCloning/fail-fast 正确。
- [x] 3.5 单测(注入 mock WS + 固定 taskId):流式帧拼接、task-failed 错误、取消、缺 key、事件序列。

## 4. config 接线(零回归)

- [x] 4.1 `tts-config.ts`:**把 `CosyVoiceTtsConfig` 加进 `TtsConfig` 闭合联合类型**(独立于 switch 的一处编辑)+ `loadTtsConfig` 加 `cosyvoice` case(model 默认 cosyvoice-v3.5-flash、voice=voiceId、format/sample_rate/endpoint 从 CHAT_A_TTS_*;apiKey 回落 CHAT_A_DASHSCOPE_API_KEY);未配置不变。
- [x] 4.2 `tts-registry.ts`:加 `createCosyVoiceTts` 工厂 + registry 映射项(`{[K in TtsConfig['kind']]:...}` 需同步否则 typecheck 挂)+ **扩展 `TtsPorts` 注入口**(cosyVoiceWsFactory 和/或 fetch)并在 `createTts` 串到 provider——spec"注入 wsFactory 单测不触网"依赖此口落实。
- [x] 4.3 复刻引擎选择:`CHAT_A_VOICE_CLONE_KIND=qwen|cosyvoice`(默认 qwen);`packages/providers/src/index.ts` **导出全部三个新模块**(cosyvoice-voice-clone、cosyvoice-tts、dashscope-upload)。
- [x] 4.4 回归断言:不设新 env 时 loadTtsConfig/复刻路径产出逐字不变(快照/golden);确认 `kind ?? (hasOpenAi?...)` 默认路径不被新 case 扰动。

## 5. desktop 复刻管线适配(desktop-electron-frontend)

- [x] 5.1 🔴 `cloneVoiceViaDashScope`(main.ts:145 现**硬调 qwen `createVoice` 具名 import**)加显式引擎分支:`CHAT_A_VOICE_CLONE_KIND==='cosyvoice'` → 新 import `createCosyVoice`(读盘→上传→create→轮询);否则走现有 qwen。**并把 AbortSignal 透传给 createCosyVoice**(否则 UI 取消按钮对多分钟轮询无效)。失败优雅降级、不崩。
- [x] 5.2 🔴 改 persist/route 三件套的 qwen 硬编码(不止 resolveCloneTargetModel):
  - `resolveCloneTargetModel`(main.ts:124)现 `includes('vc')` 对 `cosyvoice-v3.5-flash` 返 false→错路由成 qwen 快照;改为按引擎判定(cosyvoice → 返 cosyvoice-v3.5-flash)。
  - `persistVoiceId`(main.ts:158)现无条件写 `CHAT_A_TTS_KIND='qwen-tts'` + `CHAT_A_TTS_VOICE_CLONING='1'`;cosyvoice 引擎须改写 `CHAT_A_TTS_KIND='cosyvoice'`、不写 qwen 专用复刻位。
  - 结果:cosyvoice 复刻成功后 .env.local 的合成 model==target_model(cosyvoice-v3.5-flash)、KIND==cosyvoice,满足一致性硬约束;qwen 路径逐字不变。
- [x] 5.3 进度反馈:**新增 `IPC.voiceCloneProgress` 通道 + `CloneVoicePort.onProgress` 钩子**(ipc-contract/main/preload/api/renderer 全链路),轮询期推"复刻处理中";**不要复用 `voice:status`**(那是 naudiodon 麦克风可用性、语义不符)。
- [x] 5.4 desktop typecheck + build:bundle 通过(注意共享文件闭合 token 纪律,见合并教训)。

## 6. 收口与校验

- [x] 6.1 全量 `pnpm -r typecheck` + 相关包测试绿;新增契约测试覆盖各 build/parse 纯函数。
- [x] 6.2 `openspec validate cosyvoice-clone-synth --strict` 通过。
- [x] 6.3 在 README/对应文档补 CosyVoice 启用说明(env、北京地域、须先复刻)+ 标注真机校准项(design Open Questions),便于用户真机一次跑通。
