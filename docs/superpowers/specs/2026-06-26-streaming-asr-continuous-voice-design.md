# 流式 ASR / 全程流式语音 设计（Design v1.0）

- 日期：2026-06-26
- 状态：待评审（brainstorming → 转 writing-plans）
- 关联：`voice-architecture-options-survey`、`voice-device-selection-rate-decoupling-slice`、canonical `docs/chat-a-canonical-design.md` §4
- 调研依据：DashScope realtime ASR WS 协议调研（qwen3-asr-flash-realtime = OpenAI-Realtime 风格、服务端 VAD 连续分句、带 7 类情绪）。

## 1. 背景与目标

当前语音是**回合制**：本地能量 VAD 切句 → endpointing 攒 buffer → 批式 qwen-asr 整段转写。用户的心智是「**点一次免提 = 一直开着的连续对话**」，与回合制错位。目标：新增**连续流式路**，让「点一次 → 麦音频持续流给 realtime ASR、服务端 VAD 自动分句驱动回合」，达成全程流式体感。

**非目标**：真·全双工（边说边听同时转写、模型主动插话）——那是已挂起的全双工编排层（见 `2026-06-26-full-duplex-orchestration-layer-PRELIMINARY.md`）。本切片 speaking 期为「半双工门控 + 本地 VAD 打断」。

## 2. 范围决策（brainstorm 拍板）

1. **集成方式**：新增连续流式路 `voicePath='stt-stream'`，**opt-in**，默认 `stt`（批式）不变。
2. **模型**：`qwen3-asr-flash-realtime`（OpenAI-Realtime 风格 WS，与现有 omni provider 同源；服务端 VAD 连续分句；保留 7 类情绪→接现有 prosody→PAD）。固定 16k 输入（复用现有重采样）。
3. **回声处理**：speaking（TTS 播放）期**暂停 mic→ASR 推流**（防小雪自己的声音被采回云端转写出回声伪回合）+ 保留本地能量 VAD/EchoGuard 做语音打断。
4. 失败一律**回落批式 stt 路**，绝不崩（§3.2）。

## 3. 架构与接缝

### 3.1 新接缝 `StreamingSttPort`（runtime，与 `OmniAudioPort` 平级）
```ts
export interface StreamingSttPort {
  /** 开一条长连接流式转写会话;持续 pushAudio,经 handlers 吐事件;返回可关句柄。 */
  openSession(handlers: StreamingSttHandlers, opts?: StreamingSttOpts): StreamingSttSession;
}
export interface StreamingSttHandlers {
  onSpeechStarted(): void;                                   // 服务端 VAD:用户开口
  onPartial(text: string, emotion?: SttEmotion, lang?: string): void;  // 临时转写
  onFinal(text: string, emotion?: SttEmotion, lang?: string): void;    // 一句定稿 = 一个回合
  onError(err: unknown): void;                              // 连接/协议错误(由消费者决定降级)
}
export interface StreamingSttSession {
  pushAudio(chunk: PcmChunk): void;  // 推一帧/块 16k mono s16le
  close(): void;                     // 幂等;发 finish + 关 WS
}
export interface StreamingSttOpts { readonly language?: string; }
```
- 形态等价于「omni 端口」的连续会话变体,但**只转写、不生成回复**（回复仍走现有 LLM+TTS）。

### 3.2 Provider `QwenAsrRealtimeStt`（packages/providers）
- 实现 `StreamingSttPort`，WS（OpenAI-Realtime 风格，复用 omni provider 的 `OmniWsLike`/`OmniWsFactory` 注入式 WS 范式，惰性 import `ws`）。
- 握手：收 `session.created` → 发 `session.update`：`input_audio_format:'pcm'`、`sample_rate:16000`、`input_audio_transcription.language?`、`turn_detection:{type:'server_vad', silence_duration_ms:400}`。
- 推音频：`pushAudio` → 16k/16-bit/mono PCM → base64 → `input_audio_buffer.append`（约每 ~100ms 一包）。
- 收事件映射 handlers：`input_audio_buffer.speech_started`→onSpeechStarted；`conversation.item.input_audio_transcription.text`→onPartial（拼 `text`+`stash`，带 `emotion`/`language`）；`conversation.item.input_audio_transcription.completed`→onFinal（`transcript`+emotion+lang）；`error`/`...failed`→onError。
- `close()`：发 `session.finish` → 关 WS（幂等、吞错）。
- 构造惰性不触网（首次 openSession 才建连）。
- 配置：model `CHAT_A_STT_REALTIME_MODEL`（缺省 `qwen3-asr-flash-realtime`）、key `CHAT_A_DASHSCOPE_API_KEY`、baseURL `CHAT_A_STT_REALTIME_BASE_URL`（缺省 realtime WS 端点常量）。

### 3.3 VoiceLoop 连续路（packages/runtime/src/voice-loop.ts）
- `VoiceLoopDeps` 增可选 `streamingStt?: StreamingSttPort`；`VoicePath` 增 `'stt-stream'`。
- 仅当 `voicePath==='stt-stream'` 且注入了 `streamingStt` 时走连续路（双保险：缺端口回落批式 stt，逐字不变）。
- 启动：`loop.start()` 时 `openSession`，保存 session。
- 上行：`#onAudio` 在连续路下——**listening 态**：每帧 `session.pushAudio`（不走本地 endpointing 攒 buffer）；**speaking 态**：暂停 pushAudio + 复用现有 EchoGuard/能量 VAD 检语音打断（检出 → `#interrupt` + 恢复推流）。
- 事件驱动回合：`onSpeechStarted`→（listening→thinking 语义，准备接话/状态行）；`onFinal(text,emotion)`→ 走现有 `#send`(LLM 流式)+ 凑句 TTS（**复用现成回合核心**，emotion 经现有 prosodyEmotion 通道并入 PAD）；空 final 忽略。
- 本地能量 VAD/endpointing/speech-gate 在此路**仅用于 speaking 期打断**，不做分句（云端 server_vad 负责）。

### 3.4 装配（packages/client/src/cli-voice.ts）
- 新增 `createStreamingSttPort(env)`：`voicePath==='stt-stream'` 时构造 `QwenAsrRealtimeStt`；key 缺失/构造失败 → 打印中文提示返回 undefined（回落批式 stt，同 `createOmniAudioPort` 范式）。
- `startVoiceMode`：`loadVoicePath` 增识别 `stt-stream`；据此构造并注入 `streamingStt` + `voicePath`；状态行如实反映生效路径。

## 4. 数据流

```
点一次免提 → openSession(WS建连, server_vad)
listening: 麦帧(16k) → session.pushAudio → input_audio_buffer.append
   云server_vad → speech_started / transcription.text(partial) / completed(final+emotion)
   onFinal → #send(LLM 流式 token)→ 凑句 → TTS → speaking
speaking(TTS播放中): 暂停 pushAudio(防回声) ; 本地能量VAD/EchoGuard 检打断
   检出用户连续语音 → #interrupt(停TTS,abort) → 恢复 pushAudio → 回 listening
会话结束/quit: session.close(finish + 关WS)
```

## 5. 错误处理与降级（§3.2）

- key 缺 / 构造失败 / 选 stt-stream 但无端口 → 回落批式 stt 路（明确中文提示）。
- 运行期 WS 断连/`onError` → 记 warn + 尝试重连一次；再失败 → 本会话降级批式 stt（关 session，后续回合走本地 VAD+批式），回 listening，不崩。
- `onFinal` 空文本 → 忽略（不空转）。
- 所有 push/close 幂等、吞错。

## 6. 测试（不靠真麦，确定性）

- **`QwenAsrRealtimeStt`**（providers）：注入 **FakeWs**，脚本化喂服务端事件（session.created → speech_started → transcription.text → completed 带 emotion/lang → error 分支）；断言 handlers 正确触发、音频以 base64 `append` 发出、close 发 finish。
- **VoiceLoop 连续路**（runtime）：注入 **fake StreamingSttPort**：
  - `onFinal` → 断言 `#send` 被调 + 走 TTS 回合 + emotion 经 prosody 通道；
  - speaking 期 `onSpeechStarted`/本地 VAD → 断言打断；
  - speaking 期断言**暂停 pushAudio**；
  - 未注入端口（即便 voicePath=stt-stream）→ 回落批式 stt，逐字现状。
- **装配**（client）：`createStreamingSttPort` key 缺→undefined 回落；`loadVoicePath` 识别 stt-stream。

## 7. 前置（先排雷再大写）

**连通 smoke `scripts/asr-realtime-smoke.ts`**（手动跑、不进 CI）：建 WS 连接 + `session.update(server_vad)` + 喂 `out.wav`(降 16k) 的 `append` + 收 partial/final 打印 → **确认账号能用 `qwen3-asr-flash-realtime`**（调研标注的「日期快照/邀测」不确定项，验通再投入大实现）。无 key 跳过退出 0、绝不打印 key。

## 8. 主要改动文件

- 新增：`packages/providers/src/qwen-asr-realtime-stt.ts`、`scripts/asr-realtime-smoke.ts`
- 改：`packages/runtime/src/voice-loop.ts`（StreamingSttPort 接缝 + 连续路 + VoicePath 加 stt-stream）
- 改：`packages/client/src/cli-voice.ts`（createStreamingSttPort + loadVoicePath + startVoiceMode 装配）
- 改：`packages/providers/src/index.ts`、`packages/runtime/src/index.ts`（导出）
- 测试：各对应 test

## 9. 开放项

- realtime 端点形态（经典网关 vs workspace 维度）、最大连接时长/心跳、计费——上线前控制台/实测确认（调研已列）。
- speaking 期暂停推流期间，云端 server_vad 不感知用户，打断完全靠本地 VAD——本切片接受；真全双工留后续。
- paraformer-realtime-v2（任意采样率/无情绪）作为备选 provider，可后续 Factory 接缝加，不在本切片。
