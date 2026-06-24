# design — qwen-tts-realtime 接入设计

## 1. DashScope qwen-tts-realtime WebSocket 协议关键点(调研结论)

来源:阿里云 Model Studio 官方文档 *Real-time speech synthesis - Qwen TTS*
(`https://www.alibabacloud.com/help/en/model-studio/qwen-tts-realtime`)+ 既有调研 [[qwen-dashscope-api-params]]。
**协议风格 = OpenAI-Realtime**(非经典 DashScope `run-task`;后者是 CosyVoice 那套)。

### 1.1 端点与鉴权
- 北京区:`wss://dashscope.aliyuncs.com/api-ws/v1/realtime`(本项目默认)。
- 海外(新加坡)区:`wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime`(可经配置覆盖)。
- 鉴权:连接时附加请求头 `Authorization: Bearer <DASHSCOPE_API_KEY>`(**不打印 key**)。
- model 以连接 query 参数或 session 传入;model id **做成配置项、别写死日期快照**
  (稳定别名 `qwen3-tts-flash-realtime` / `qwen3-tts-instruct-flash-realtime`;instruct 版才吃 `instructions`)。
- 60 秒无消息服务端断连;本切片为「一句合成即关连接」的短生命周期,不需要心跳。

### 1.2 客户端 → 服务端事件(逐条 JSON)
- 握手配置:
  ```json
  { "type": "session.update",
    "session": { "voice": "Cherry", "response_format": "PCM_24000HZ_MONO_16BIT", "mode": "server_commit" } }
  ```
  可选(仅 instruct 版生效):`session.instructions`(自然语言情感/风格,≤1600 token)、`optimize_instructions`(bool);
  另有 `speech_rate` / `volume` / `pitch_rate` / `language_type` 等微调位。
- 送文本:`{ "type": "input_text_buffer.append", "text": "..." }`
  - ⚠️ **协议歧义**:官方文档抓取里 `append` 的文本字段一处呈 `{ "text": "..." }`、另一处呈
    `{ "arguments": { "text": "..." } }`。本实现采用更常见、与 OpenAI-Realtime 一致的 **`{ type, text }`** 形态,
    并把「append 消息体构造」抽成一个**可注入/可改的内部函数**(爆炸半径可控:真机若证实是 `arguments` 形态,改一处即可)。
- 收尾(`commit` 模式才需要;`server_commit` 模式服务端自动切分):
  `{ "type": "input_text_buffer.commit" }`
- 结束本次合成会话:`{ "type": "session.finish" }`
- 打断/丢弃:`{ "type": "input_text_buffer.clear" }`(+ 本地丢弃播放队列 / 关 WS);**无 cancel 事件**,barge-in 靠 clear+关连接。

### 1.3 服务端 → 客户端事件
- `session.created`(含 `session.id`)、`session.updated`(配置确认)。
- `response.audio.delta`:音频块,base64 文本在 **`delta`** 字段;默认 `PCM_24000HZ_MONO_16BIT`(s16le, 24kHz, mono)。
- `response.audio.done` / `response.done` / `session.finished`:合成/会话结束。
- `error`:含错误详情(鉴权失败、参数错、配额等)。

### 1.4 输出音频格式 → PcmChunk 对齐
- 默认 `PCM_24000HZ_MONO_16BIT` = **24000Hz / mono / Int16 小端**,与项目 `TTS_SAMPLE_RATE_HZ=24000`、
  `PcmChunk{samples:Int16Array, sampleRate, channels:1}` **天然对齐**。
- 解码:`Buffer.from(delta, 'base64')` → Uint8Array → 按 Int16 边界(每 2 字节)切;跨帧半样本残留进位到下一帧
  (沿用 `openai-compat-tts.ts` 的 `carry` 写法,保证不产半样本)。

## 2. 可测试性:WebSocket 注入式端口(R1,镜像 KokoroSession)

worktree 单测**不触真网络**。把「建 WS 连接」抽成端口 `QwenWsFactory`:
```
type QwenWsFactory = (url: string, headers: Record<string,string>) => QwenWsLike;
interface QwenWsLike {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'open'|'message'|'error'|'close', cb: (arg?: unknown) => void): void;
}
```
- 缺省工厂:**懒加载** `ws` 包(`await import('ws')`)建真连接,只在真正合成时引入,类型层用最小 `QwenWsLike` 面、
  不把 `ws` 类型泄漏到接口签名。
- 测试注入 mock:一个 in-memory 假 WS,可脚本化「open→audio.delta×N→response.done」「error」「open 后挂起以测取消」,
  断言产出的 `PcmChunk`、取消时是否发了 `input_text_buffer.clear` / `close`。

## 3. 流式与低首音延迟
- `synthesize` 是 async generator:`open` 后立刻 `session.update`+`append`+(commit/finish),
  **收到第一个 `response.audio.delta` 立刻 yield**,不等整段——首音延迟 ≈ 首帧 RTT。
- 帧到达用一个**异步队列**(内部 push + Promise 唤醒)桥接「事件回调」与「for-await 拉取」,
  done/error/close 推哨兵结束迭代。

## 4. AbortSignal 真取消
- 进入 `synthesize` 即检查 `signal.aborted`(已取消则直接抛/空产出)。
- 监听 `signal` 的 `abort`:发 `input_text_buffer.clear` + `close()` WS + 让队列以「已取消」结束
  (抛 `AbortError` 或干净停止迭代,与现有 TTS 一致;VoiceLoop 据此即时静音)。
- finally 里**务必**移除 listener、关 WS(防泄漏/防后台烧额度)。

## 5. 优雅降级
- 连接 `error` / `close`(非正常)/ 服务端 `error` 事件 → 抛**带上下文的中文 Error**(含 provider id、阶段、
  错误码/消息片段,**绝不含 key**)。
- 缺 apiKey:构造即 fail-fast(清晰提示设 `CHAT_A_DASHSCOPE_API_KEY` / `CHAT_A_TTS_API_KEY`)。
- 上层(VoiceLoop/factory)按既有策略决定回退(如降级到 fake / 文字兜底),本 provider 只负责「明确报错而非静默/崩」。

## 6. 能力声明
```
{ languages: ['*'],            // qwen-tts 多语种内置
  voiceId: [<默认 voice>],     // Cherry/Chelsie/Serena…
  sampleRate: 24000,
  streaming: true,
  voiceCloning: false }        // realtime 内置音色,不支持 zero-shot 复刻 → 传 refAudio fail-fast
```

## 7. 边界与爆炸半径
- 只新增/改 `packages/providers/**`。`append` 消息构造、端点、model、response_format、mode 全部**配置化/集中常量**,
  无 magic number;真机校验后若需改协议细节,改一处即可(模块级大改可控)。
