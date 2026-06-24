## ADDED Requirements

### Requirement: 后端复刻模块从参考音频创建专属音色

系统 SHALL 提供 `createVoice(audio, opts, signal?)`,接受**本地音频**(字节 + MIME,或本地文件路径)与创建选项(`apiKey`、`targetModel`、可选 `preferredName`/`endpoint`/`model`/`fetch`),向 DashScope 千问声音复刻端点(`POST .../api/v1/services/audio/tts/customization`,`model: "qwen-voice-enrollment"`、`input.action: "create"`)提交请求,并返回 `{ voiceId }`。参考音频 MUST 以 **base64 data URI**(`data:audio/<mime>;base64,...`)放入 `input.audio.data`,使用户无需提供公网 URL 或上传 OSS。

#### Scenario: 从音频字节创建音色并解析 voiceId
- **WHEN** 以 `{ data: <字节>, mime: 'audio/wav' }` 与 `{ apiKey, targetModel: 'qwen3-tts-vc-realtime-2026-01-15' }` 调用 `createVoice`
- **THEN** 请求体 `model` 为 `qwen-voice-enrollment`、`input.action` 为 `create`、`input.target_model` 为传入的 `targetModel`、`input.audio.data` 为该字节的 base64 data URI(含 MIME 前缀)
- **AND** 鉴权头为 `Authorization: Bearer <apiKey>`
- **THEN** 从响应 `output.voice` 解析出 voiceId 并以 `{ voiceId }` 返回

#### Scenario: 本地文件路径自动读盘并按扩展名推断 MIME
- **WHEN** 以 `{ path: 'ref.mp3' }` 在 Node 侧调用 `createVoice`
- **THEN** 系统读取该文件字节、按扩展名推断 MIME(`.mp3`→`audio/mpeg`)并编码为 base64 data URI 放入请求

#### Scenario: 超过大小上限提前拒绝
- **WHEN** 参考音频原始字节超过 10MB
- **THEN** `createVoice` 在发起网络请求前抛出清晰中文错误(提示压缩或截短),不消耗一次远端往返

### Requirement: 复刻模块支持查询与删除音色

系统 SHALL 提供 `listVoices(opts, signal?)` 与 `deleteVoice(voiceId, opts, signal?)`,经同一端点以 `input.action` 区分(`list`/`delete`),用于校验音色存活与清理。HTTP 契约中尚未由官方完整公开的部分(action 动词、list 响应字段名)MUST 抽成可单独修改的纯函数,以便真机校准时**只改一处**。

#### Scenario: 删除音色构造正确请求
- **WHEN** 以某 voiceId 调用 `deleteVoice`
- **THEN** 请求体 `model` 为 `qwen-voice-enrollment`、`input.action` 为 `delete`、并携带该 voiceId
- **AND** 鉴权头为 `Authorization: Bearer <apiKey>`

#### Scenario: 列举音色解析出音色列表
- **WHEN** 调用 `listVoices` 且服务端返回音色数组
- **THEN** 系统经可改解析函数从响应解析出 voiceId 列表返回

### Requirement: 复刻模块鉴权缺失与错误优雅降级

`createVoice`/`listVoices`/`deleteVoice` MUST 在缺少 apiKey 时 fail-fast、在非 2xx 或解析失败时抛出清晰中文错误,且**任何错误信息绝不包含 API key**。fetch SHALL 可注入(缺省 `globalThis.fetch`),使单元测试不触真实网络。

#### Scenario: 缺 key fail-fast
- **WHEN** 以空 apiKey 调用 `createVoice`
- **THEN** 抛出提示设置 `CHAT_A_DASHSCOPE_API_KEY` 的中文错误,且错误文本不含任何 key 内容

#### Scenario: 非 2xx 响应抛中文错误且不含 key
- **WHEN** 注入的 fetch 返回非 2xx 与错误体
- **THEN** 抛出带响应片段的中文错误,便于真机定位,且不打印鉴权头/ key

#### Scenario: AbortSignal 取消
- **WHEN** 调用时传入已 abort 的 `AbortSignal`
- **THEN** 请求被取消,不向上抛未处理异常

### Requirement: 桌面端一键复刻并持久化 voiceId

Electron 渲染层 SHALL 提供"复刻小雪声音"区:用户选择本地音频文件后一键触发复刻,经 IPC `voice:clone` 把文件交主进程;主进程读取文件、调用 `createVoice`、拿到 voiceId 后 SHALL **持久化**到项目根 `.env.local` 的 `CHAT_A_VOICE_ID` 并即时注入当前进程环境,使后续合成自动使用该音色。复刻过程的结果(成功 voiceId / 失败中文原因)MUST 回推渲染层显示。无 `CHAT_A_DASHSCOPE_API_KEY` 时该区 MUST 禁用并给出中文提示;复刻任何失败 MUST 友好降级且**主进程绝不崩溃**。

#### Scenario: 一键复刻成功并写入配置
- **WHEN** 用户选择一段本地音频并点击复刻、主进程 `createVoice` 返回 voiceId
- **THEN** 主进程把 voiceId 写入 `.env.local` 的 `CHAT_A_VOICE_ID`(保留文件其它行)并设入当前进程 env
- **AND** 渲染层收到成功结果并显示该音色已就绪

#### Scenario: 无 key 禁用复刻区
- **WHEN** 环境缺少 `CHAT_A_DASHSCOPE_API_KEY`
- **THEN** 渲染层复刻区被禁用并展示中文提示(在 `.env.local` 填 key 后可用)

#### Scenario: 复刻失败友好降级
- **WHEN** `createVoice` 抛错(网络/契约/音频不合规)
- **THEN** 主进程捕获错误、回推友好中文文案给渲染层,不向上抛、不崩溃

#### Scenario: 写 .env.local 保留既有内容
- **WHEN** `.env.local` 已存在其它键(及注释)
- **THEN** 写入 `CHAT_A_VOICE_ID` 时改既有键或追加新行,其余行逐字保留;文件不存在则新建
