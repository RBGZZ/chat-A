# 设计:Qwen Omni Realtime LLM Provider(audio-in → 文本流)

## 1. DashScope Realtime WS 协议关键点(已核实)

来源:官方文档 `https://www.alibabacloud.com/help/en/model-studio/realtime`(Qwen-Omni-Realtime)+ memory `qwen-dashscope-api-params`(调研结论)。**已用 WebFetch 核对官方文档**,以下为协议要点(写入此处以便追溯,§可追溯性原则):

### 1.1 连接与鉴权
- 端点(北京):`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`(国际:`dashscope-intl`)。
- 查询参数:`?model=<model-id>`,如 `qwen3.5-omni-flash-realtime` / `qwen3.5-omni-plus-realtime`。
  - ⚠️ **model id 做成配置项**,不写死:官方文档示例用 `...-plus-realtime`,memory 调研用 `...-flash-realtime`,快照日期名未确证;由 `LlmConfig.model` 传入。
- 鉴权:连接时带 header `Authorization: Bearer <DASHSCOPE_API_KEY>`(WS 握手 header)。
- 单会话最长 ~120 分钟自动关闭;60 秒无消息服务端断连(长连需心跳,本 change 一问一答短连不涉及)。

### 1.2 客户端事件(Client → Server)
- `session.update`:配置 `session`,关键字段:
  - `modalities`: `["text"]`(只要文本输出,本 change 用)/ `["text","audio"]`。
  - `input_audio_format`: `"pcm"`(裸 PCM 16-bit / 16kHz / mono,base64)。
  - `output_audio_format`: `"pcm"`(本 change 不取音频输出)。
  - `instructions`: 系统提示(自然语言)。
  - `turn_detection`: `{ type:"server_vad", threshold, silence_duration_ms }`,或设 `null` 走手动模式(commit + response.create)。
- `input_audio_buffer.append`: `{ type, audio:"<base64 PCM>" }` 追加音频。
- `input_audio_buffer.commit`: 手动模式提交缓冲音频。
- `response.create`: 手动模式请求生成。
- (纯文本对话路径)`conversation.item.create` 携带 `input_text` 内容项 → `response.create`:把文本 prompt 当作一条用户消息送入,等价「文本 LLM over WS」。

### 1.3 服务端事件(Server → Client)
- `session.created`:连接就绪(收到后再发 session.update / 数据)。
- `session.updated`:session.update 已生效。
- `input_audio_buffer.speech_started` / `..speech_stopped`:服务端 VAD 端点。
- `conversation.item.input_audio_transcription.completed`:含 `transcript` 字段 = **用户输入音频的转写**(记忆/召回要的用户话语文本)。
- `response.text.delta`:文本模式下的回复增量,字段 `delta`。
- `response.audio_transcript.delta`:音频模式下回复的转写增量,字段 `delta`(本 change 兼容收取,作为文本回退)。
- `response.audio.delta`:音频输出 base64(本 change 不取)。
- `response.done` / `response.completed`:本轮回复结束。
- `error`:错误事件(鉴权失败/参数错误等)。

### 1.4 音频格式
- 输入:**16-bit / 16kHz / mono PCM**,base64 编码 → 与项目 `PcmChunk`(STT 入 16kHz mono s16le)一致,边界直接 base64 编码 `Int16Array` 字节即可。
- 输出音频固定 24kHz(本 change 不用)。

## 2. Provider 设计(`QwenOmniLlm`)

### 2.1 双表面:文本 LLM 兼容 + 真多模态
- **文本兼容面**(implements `LlmProvider`):`stream(req)` / `complete(req)`。把 `req.system` 当 `instructions`、`req.messages` 末条用户文本经 `conversation.item.create(input_text)` + `response.create` 送出,聚合 `response.text.delta` 回吐字符串流。
  - 价值:**直接装进 registry 当 LLM 用**,VoiceLoop 现有 STT→LLM 路径**零改**即可把 LLM 换成 `qwen-omni`(走 WS 而非 HTTP)。这是「不破坏现有路径、可选替代」的最小落点。
- **真多模态面**(额外方法,非 `LlmProvider` 必需):`respondToAudio(audio: AsyncIterable<PcmChunk>, opts?, signal?): AsyncIterable<OmniEvent>`。
  - `OmniEvent` 判别联合:`{type:'transcript', text}`(用户话语,源自 input_audio_transcription.completed)| `{type:'text', text}`(回复增量)| `{type:'end'}`。
  - 这是 omni 的核心价值(从原始音频感知),供后续 runtime 接入 audio-in 直路。**本 change 不接 VoiceLoop**,只提供并测试此面。

### 2.2 一次会话生命周期(一问一答短连)
1. `wsFactory(url, { headers })` 建连(默认用 `ws` 包;可注入 mock)。
2. 等 `session.created` → 发 `session.update`(modalities/format/instructions/turn_detection)。
3. 文本面:发 conversation.item + response.create;音频面:流式 `input_audio_buffer.append`,server_vad 自动触发或 commit+response.create。
4. 收事件:text.delta → yield;transcript.completed → yield(音频面);response.done → 结束、关 WS。
5. `error` 事件或 WS error/close(非正常)→ 抛清晰错误。

### 2.3 AbortSignal 真取消(§3.2)
- signal 已 abort → 直接抛(fail-fast,不建连)。
- 流式中 abort → 关闭 WS、终止 async 生成器(承 VoiceLoop 打断会 abort send 的 signal,使底层流真停)。
- 用 `once('abort')` 监听;清理时移除监听、关 WS,幂等不抛。

### 2.4 能力门 fail-fast + 优雅降级
- 构造期不连;首次 `stream`/`complete`/`respondToAudio` 才连(惰性,装配不触网)。
- apiKey 缺失 → registry 工厂抛清晰中文错误(同 deepseek/qwen 风格)。
- 连接/鉴权失败 → 抛错;**降级由调用方处理**:registry 装配处或上层网关(承 v3 §四路由:omni 失败 enterCooldown → textPath)。本 change 文本面抛错后,VoiceLoop 的 send.catch 会回 listening(已有兜底);更完整的「自动切到 deepseek」是网关层后续事。

### 2.5 可测性:WS 注入
- 构造选项 `wsFactory?: (url, opts) => OmniWsLike`,`OmniWsLike` 是最小 WS 接口(`on(event,cb)` / `send(data)` / `close()` / `readyState`)。
- 默认实现 import `ws`;测试传 FakeWs(同步驱动 open/message/close),断言:正常文本流式、audio-in transcript+text、abort 中途取消、error 事件降级抛错。**不触网**。

## 3. 与 VoiceLoop 的集成/降级方案

### 3.1 现状(不改)
VoiceLoop = VAD→EOU→**STT**→`send(text)`→TTS。`send` 注入 `conversation.send.bind(conversation)`,Conversation 内部用 `createLlm(config)` 得到的 LLM `stream`。

### 3.2 路径 A:文本面替换(本 change 已可用,零 runtime 改)
把 `CHAT_A_LLM_PROVIDER=qwen-omni` → Conversation 拿到 `QwenOmniLlm`,其 `stream` 走 WS 但签名与普通 LLM 一致。VoiceLoop 仍先 STT 再喂文本。**好处**:立刻可用、不破坏任何现有逻辑;**代价**:仍走 STT,未发挥 audio-in 情绪感知。

### 3.3 路径 B:audio-in 直路(后续,需 runtime 改 = 主控/独立 change)
VoiceLoop 增可选 omni 分支:endpointing 攒的音频帧不喂 STT,而喂 `qwen-omni.respondToAudio(audioChunks)`,消费 transcript(写记忆)+ text(凑句喂 TTS)。需在 VoiceLoopDeps 加可选 omni 接缝 + 状态机微调。**本 change 不做**,只在此设计说明接缝形状,降级:omni 不可用/失败 → 落回路径 STT→LLM(v3 §六故障链)。

## 4. 一致性自检
- §3.1 接缝:加 `qwen-omni` 只在 registry 登记,createLlm 核心零改。
- §3.3 能力驱动:omni 多 audio-in 能力(respondToAudio);系统对厂商无感。
- §3.2 行为即配置(WS URL/model 外置可覆盖、无 magic)+ 优雅降级(失败抛清晰错,上层降级)+ 真打断(AbortSignal 关 WS)。
- 边界:只改 providers,不碰 TTS / VoiceLoop。
