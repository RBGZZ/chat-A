## Why

qwen 云音色复刻(`qwen-voice-enrollment` + `qwen3-tts-vc-realtime`)真机实测**保真度低**——同一段参考音频在别的服务能复刻"像",qwen 复刻出来"连贯但不像",且无质量参数可调、改不动(见记忆 `qwen-tts-clone-model` §6)。这与北极星"长期伴侣需要专属、可辨识的声音"直接冲突。CosyVoice v3.5 的零样本复刻保真度公认更高,是更可能让小雪"声音像她自己"的路径。

CosyVoice 与现有 qwen 复刻/TTS 是**完全不同的两套契约**(复刻只收公网 URL+异步轮询;合成走 DashScope `run-task` WS 协议+二进制裸 PCM 帧,而非 qwen 的 OpenAI-Realtime 风格+JSON base64),现有 provider 无法复用,需新建。

## What Changes

- **新增 CosyVoice 复刻链路**:`createVoice` 走 CosyVoice 契约(`model:voice-enrollment`、`action:create_voice`、`target_model:cosyvoice-v3.5-flash`、`prefix`、`url`、`language_hints`、返回 `output.voice_id`),create 后**异步轮询** `query_voice` 直到 `status:OK`;管理用 `list_voice`/`delete_voice`(字段 `voice_id`)。与现有 qwen 裸动词契约并存、互不影响。
- **新增 DashScope 临时文件上传**:本地音频 → `GET /api/v1/uploads?action=getPolicy` → multipart 上传 OSS → 拿 `oss://` 临时 URL(48h)→ 供复刻 `url` 字段使用(调用时加头 `X-DashScope-OssResourceResolve: enable`)。这样 desktop"选本地文件一键复刻"的零操作 UX 在"只收公网 URL"约束下仍成立,无需用户自备 OSS。
- **新增 `CosyVoiceTts` provider**(implements `TtsProvider`):DashScope `run-task`/`continue-task`/`finish-task` WS 协议,端点 `/api-ws/v1/inference`,`parameters.voice`=复刻 voiceId、`format:pcm`/`sample_rate:24000`,服务端二进制裸 PCM 帧拼接为 `PcmChunk`,`task-failed` 的 `error_message` 透出(承"排错先看 close/错误体"教训)。流式逐帧产出,契合延迟预算(§3.2)。
- **config 接线**:`CHAT_A_TTS_KIND=cosyvoice` 新档(tts-config/tts-registry);复刻链路按 `CHAT_A_VOICE_CLONE_KIND=cosyvoice` 或 `target_model` 含 `cosyvoice` 选取 CosyVoice 契约。缺省不配置时**现有 qwen/其它路径逐字不变**(零回归硬线)。
- **desktop 复刻管线适配**:主进程 `voice:clone` 据所选引擎走 CosyVoice 上传+异步轮询;复刻成功持久化 `voice_id` + `target_model`(=`cosyvoice-v3.5-flash`)+ `CHAT_A_TTS_KIND=cosyvoice`(复用本会话已做的"复刻自动持久化合成模型"机制)。轮询期向渲染层报进度状态。

## Capabilities

### New Capabilities
- `dashscope-file-upload`: DashScope 临时文件上传机制——getPolicy → OSS multipart → `oss://` URL(48h)+ `X-DashScope-OssResourceResolve` 头;可注入 fetch、单测不触网;供声音复刻(及未来其它需公网 URL 的 DashScope 接口)复用。

### Modified Capabilities
- `voice-cloning`: 新增 CosyVoice 复刻契约(create_voice/url/language_hints/output.voice_id/异步 query_voice 轮询/list_voice/delete_voice),与现有 qwen 契约并存,经引擎选择路由。
- `tts-engine`: 新增 CosyVoice `run-task` WS 合成 provider(二进制帧、task-failed 错误、合成 model 须与复刻 target_model 逐字一致),与现有 qwen-tts/其它 provider 并存。
- `desktop-electron-frontend`: 复刻入口适配 CosyVoice 管线(本地文件→临时上传→异步轮询→持久化),轮询进度反馈;缺省/其它引擎行为不变。

## Impact

- **新增代码**:`packages/providers/src/` 下 CosyVoice 复刻模块、`cosyvoice-tts.ts`、`dashscope-upload.ts`(或并入复刻模块);tts-config/tts-registry 加档;desktop main 复刻处理分支。
- **契约风险(隔离 + 真机校准)**:getPolicy 的 `model` 参数取值、create_voice 是否接受 `oss://`+该头、合成期 `language_hints` 是否生效、端点二选一(`dashscope.aliyuncs.com` vs `{WorkspaceId}.maas`)、v3.5-flash 推荐 format/sample_rate——均文档未完全明确,**全部隔离在可改纯函数,真机不符改一处**(承模块化/可追溯纪律)。
- **依赖**:复用现有 `ws`(WS)与 `fetch`;无新增重依赖。北京地域限定 + 无系统音色(必须先复刻)需在文档/降级提示中说明。
- **canonical 接缝**:§4.1(音色复刻/TTS 可换性)、§4.3(provider Factory 接缝)、§3.2(流式延迟)、§3.1(注入式可测、优雅降级)。不触碰 §5 记忆/§6 人格/帧管线。
- **延迟预算(§3.2)**:合成为流式逐帧,不引入额外阻塞;复刻为离线一次性操作(+异步轮询),不在首字延迟热路径。
