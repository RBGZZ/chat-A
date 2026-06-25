# 参考项目「语音输入 + 语音输出」实现调研（2026-06-25）

> 只读调研产出（UTF-8 中文）。**任务定位：补全输入侧（VAD/EOU/STT 流式/打断）**——已有文档 `streaming-fast-response-findings-2026-06-25.md` 偏输出侧（首音延迟/句切/流式 TTS），本文**在其之上补充、不重复**，重点放在「麦克风采集 → VAD → 端点检测(EOU) → STT → barge-in」这条输入链。
>
> 证据等级：**[已验证]**=本人直读 reference/ 源码 file:line（关键参数已用 grep/sed 核实）；**[子代理]**=并行子代理读取汇报、未逐行复核（行号可能 ±少量偏差，机制结论可信）；**[推断]**=由代码/约定推导。
>
> 参考根：`D:/chat-A/reference/`，neuro 生态在 `reference/github-projects/neuro-ecosystem/`（下称 `…neuro/`）。
>
> chat-A 现状对照见各节末尾与 §对 chat-A 的建议。chat-A 现有输入链：麦克风(naudiodon) → VAD(packages/voice-detect) → EOU(双 EMA 动态 endpointing) → STT(qwen3-asr-flash，multipart 整段上传) → LLM → 流式 TTS(CosyVoice/qwen run-task) → 播放。

---

## 0. 一句话结论（输入侧）

chat-A 输入链**最大的两个缺口**：(1) **没有 barge-in（用户说话打断正在播放的 TTS）**——这是「伴侣感」与「不抢话/可打断」体验的命门，参考项目几乎全部实现；(2) **STT 是整段上传、无流式 partial**，无法支撑「预测性生成 / partial 驱动 EOU」这类降延迟手法。

EOU 方面 chat-A 的双 EMA 动态 endpointing 已属第一梯队（与 LiveKit 同源），**但参考项目里最值得借鉴的新东西是 RealtimeVoiceChat 的「语义 EOU 模型」**——用一个轻量 DistilBert 判断「这句话说完了没」，把静音等待时长按句子完整度概率动态收放。

VAD 方面参考项目高度收敛到 **Silero VAD**（OLV / airi / LiveKit 均用），WebRTC-VAD 是轻量退路（Zerolan / RVC 兜底）；chat-A 自有 voice-detect 可保留，但 Silero 是「PC + 树莓派可降级」的成熟锚点。

---

## 1. 各项目逐一详查（输入侧为主）

### 1.1 Open-LLM-VTuber (OLV) — Silero VAD + 整段 ASR + 服务端 barge-in

根：`…neuro/Open-LLM-VTuber/`

**A. 麦克风采集**
- 前端 `web_tool/recorder.js`：Web Audio API `getUserMedia`，16kHz / 单声道 / WAV PCM16，分块经 WebSocket 上传。[子代理]
- 服务端入口 `src/open_llm_vtuber/websocket_handler.py`：消息类型 `mic-audio-data`(原始)/`raw-audio-data`(走 VAD)，`_handle_audio_data` 累积进 `np.float32` 缓冲；`_handle_raw_audio_data` 把 chunk 喂 VAD。[子代理]

**B. VAD —— Silero VAD**（已直读核实参数）
- `src/open_llm_vtuber/vad/silero.py`：`load_silero_vad()`(:9,:51)，窗口 `window_size_samples = 512`（16kHz，约 32ms/帧，:46）。[已验证]
- 关键参数（`:17-20,:29-32`，已 grep 核实）：
  - `prob_threshold = 0.4`（语音概率阈值）
  - `db_threshold = 60`（能量/分贝阈值，与概率 AND）
  - `required_hits = 3`（连续 3 帧命中 → 判为说话开始，≈0.1s）
  - `required_misses = 24`（连续 24 帧未命中 → 判为说话结束，**≈0.768s 静音 = 其 EOU 阈值**）
  - `smoothing_window = 5`（概率/分贝滑动平均）
- 状态机 IDLE→ACTIVE→INACTIVE→IDLE（`:79-189`），带 `pre_buffer`(maxlen=20) **前置静音填充**——把说话前若干帧补到检测出的语音前（:182）。检测到说话起始 yield `b"<|PAUSE|>"`(:146)、结束 yield `b"<|RESUME|>"`(:180)。[已验证]

**C. EOU / 端点检测** —— 纯 **VAD 静音时长**（`required_misses`=0.768s），无语义 EOU 模型。**半双工**：检测到新语音即向前端发 `interrupt` 控制消息。[已验证/子代理]

**D. STT** —— Factory 多引擎 `asr/asr_factory.py`：faster_whisper / whisper_cpp / whisper(OpenAI) / fun_asr / azure / groq_whisper / sherpa_onnx。**整段（whole-utterance）转写，无 partial**：VAD 判说完 → 整段 buffer 一次性 `async_transcribe_np()`。语种按引擎 config。默认通常 faster_whisper。[子代理]

**E. Barge-in / 打断** —— **有，且做得完整**：
- `websocket_handler.py` `_handle_interrupt()` 收 `interrupt-signal`（带 `heard_response` 即「用户已听到多少」）。[子代理]
- `conversations/conversation_handler.py` `handle_individual_interrupt()`：`task.cancel()` 取消当前回合 → `agent.handle_interrupt(heard_response)` → **把已说出的半句以 `role="ai"` 写回历史，并加系统标记 `[Interrupted by user]`**（半句可回上下文）。群聊有 `handle_group_interrupt()` 广播。[子代理]
- TTS 队列清空 `conversations/tts_manager.py` `clear()`：清 task_list、cancel sender、重置 seq、换新 payload_queue。[子代理]
- **VAD 自动打断**：播放期间 VAD 出 `<|PAUSE|>` → 服务端自动向前端发 `{"type":"control","text":"interrupt"}`。[子代理]

**F. 输出侧（印证已有文档）** —— `utils/sentence_divider.py`（`faster_first_response` 首句逗号切、pysbd 句切、缩写表）；`conversations/tts_manager.py` 用**序列号**乱序合成/顺序交付。已在既有文档覆盖。[已验证]

**G. 架构** —— 半双工状态机 listening→ASR→thinking→speaking；播放完前端回 `frontend-playback-complete` 才收下一轮。WebSocket 消息总线驱动。[子代理]

---

### 1.2 RealtimeVoiceChat (RVC) — 本项目的「语义 EOU」是全场最大亮点

根：`…neuro/RealtimeVoiceChat/code/`。注：输出侧（quick/final 两段、chunk 8/30、prewarm）已在既有文档详覆盖，本节聚焦输入侧。

**A. 麦克风采集**
- 前端 `static/app.js`：`getUserMedia`（理想 24kHz、单声道、回声消除+降噪），`AudioWorklet`(`pcmWorkletProcessor.js`) Float32→Int16；**自定义二进制帧**：`[timestamp(4B) | flags(4B) | PCM 4096B]`，2048 样本/批，flags bit0 = isTTSPlaying（**把「TTS 是否在播」随每帧上报服务端**——这是 barge-in 判断的关键输入）。[子代理]
- 服务端 `server.py` `process_incoming_data()`：解 8 字节头 `struct.unpack("!II",...)`，PCM 入 `incoming_chunks` asyncio 队列（带 `MAX_AUDIO_QUEUE_SIZE` 背压）。[子代理]
- `audio_in.py`：`resample_poly(_, 1, 3)` 把 48kHz→16kHz（`_RESAMPLE_RATIO=3`）；输出侧 `upsample_overlap.py` 24→48kHz **overlap-add 平滑**跨块边界。[子代理]

**B. VAD** —— 复用 **RealtimeSTT 库**内置 VAD（已直读 config）：
- `transcribe.py` `DEFAULT_RECORDER_CONFIG`：`silero_sensitivity=0.05`（极敏感）、`webrtc_sensitivity=3`、`silero_use_onnx`、`silero_deactivity_detection`（:32-33）；`post_speech_silence_duration=0.7`（:34，**会被语义 EOU 动态改写**）。[已验证]

**C. EOU / 语义端点检测 —— 全场最有价值的输入侧机制**（已直读核实模型名与 anchor）
- 文件 `turndetect.py`。模型 `"KoljaB/SentenceFinishedClassification"`（DistilBert 句子完整度分类器，:13）；`DistilBertTokenizerFast` + `DistilBertForSequenceClassification`（:218-219），max 128 token，启动 warmup，LRU cache 256。[已验证]
- **概率→静音时长映射**（:18-21，已核实）：`anchor_points = [(0.0,1.0),(1.0,0.0)]` —— 完整度概率 0（没说完）→ 等 1.0s；概率 1（说完了）→ 等 0s，线性插值 `interpolate_detection`。[已验证]
- **加权融合**（:478-480，已核实）：`weight_towards_whisper = 0.65` → `最终停顿 = 0.65*标点建议停顿 + 0.35*语义模型停顿`，再乘 `detection_speed`（速度滑块 0.0~1.0 在 6 个停顿参数间插值），并加 ellipsis bonus，**受 pipeline 延迟下限约束 `min_pause = 0.5+0.1 = 0.6s`**。[已验证/子代理]
- 标点驱动的基础停顿：`...`→2.3s、`.`→0.39s、`!`→0.35s、`?`→0.33s、其他→1.25s（fast 档）。[子代理]
- 算出的 `final_pause` 回写进 recorder 的 `post_speech_silence_duration`（`on_new_waiting_time`，:338）——**即「按句子是否说完，动态收放 VAD 静音超时」**。[已验证]

**D. STT** —— RealtimeSTT(faster-whisper 后端，本地 `AudioToTextRecorder`)。模型 `base.en`，`enable_realtime_transcription=True`、`realtime_processing_pause=0.03`（30ms 一次 partial）。**有 partial/实时转写**：`on_partial()` 边出文本边触发语义 EOU 与「相似度防误打断」。[已验证/子代理]

**E. Barge-in / 打断 —— 工业级、含「防误打断」**
- 触发点 `server.py` `on_recording_start()`：用户说话且 `tts_client_playing` → `tts_to_client=False` + `user_interrupted=True` → 发 `stop_tts` → `abort_generations()`。[子代理]
- 核心 `speech_pipeline_manager.py` `process_abort_generation()`：用 `abort_lock` 串行，逐个停 LLM/quick-TTS/final-TTS worker（各设 stop_event + 5s 超时）、`audio.stop_playback()`、关闭 generator、清陈旧 event，最后放行 `abort_block_event`。[子代理]
- **在途音频丢弃**：`abortion_started` 置位后队列不再被拉取；客户端收 `stop_tts`/`tts_interruption` → `ttsWorkletNode.port.postMessage({type:"clear"})` 清播放缓冲。[子代理]
- **半句回上下文**：`send_final_assistant_answer(forced=True)` 把已生成的 `quick_answer+final_answer`（或最后 partial）作为最终回答送出存档。[子代理]
- **防误打断（防抖）**：`check_abort()` 用 `text_similarity.calculate_similarity()` 比对——新 partial 与正在生成的输入相似度 ≥0.95 视为同一句、**不打断**；<0.95 才真打断。这是「打字机式 partial 抖动不该触发打断」的实用护栏。[子代理]

**F/G. 输出/架构** —— quick/final 两 worker 并行、prewarm、TTFT 日志（既有文档已覆盖）；4 daemon worker 线程 + asyncio 任务，半双工（VAD 在 TTS 播放期间门控录音）。[子代理]

---

### 1.3 airi — 纯浏览器端 Silero VAD（transformers.js）+ 云 ASR + 优先级打断

根：`…neuro/airi/`（TS/Vue monorepo）

**A. 采集** —— `packages/stage-ui/src/composables/audio/audio-device.ts` `useUserMedia`（autoGainControl/echoCancellation/noiseSuppression）；`AudioContext` 16kHz + `AudioWorklet`(`apps/stage-web/src/workers/vad/process.worklet.ts`)，**512 样本/块**累积后 postMessage 给主线程 VAD。[子代理]

**B. VAD —— 浏览器内 Silero VAD（transformers.js / ONNX）**（已直读核实）
- `apps/stage-web/src/workers/vad/vad.ts`：`AutoModel.from_pretrained('onnx-community/silero-vad')`（`@huggingface/transformers`，:4,:50），状态张量 `stateN` 跨块持续。[已验证]
- 默认参数（:27-31，已核实）：`speechThreshold=0.3`、`exitThreshold=0.1`（迟滞）、`minSilenceDurationMs=400`、`speechPadMs=80`(前后填充)、`minSpeechDurationMs=250`(过短丢弃)。stage-ui 侧覆盖默认更严：阈值 0.6 / 静音 800ms。[已验证]
- **迟滞判定**（:196-197）：`prob>speechThreshold || (isRecording && prob>=exitThreshold)`——一旦进入录音用低阈值维持，防抖。[已验证]

**C. EOU** —— VAD redemption：累积 `postSpeechSamples >= minSilenceDurationSamples` 且语音段够长 → 发 `speech-end` + `speech-ready{buffer,duration}`。无语义 EOU。[子代理]

**D. STT** —— **服务端云 ASR：阿里云 NLS**（`apps/server/src/routes/audio-transcription-stream/session.ts`，已直读确认 Aliyun NLS）。`enable_intermediate_result` 可开（有 partial）、16kHz PCM，经 SSE 把 `transcript.text.delta` 推回。**未见浏览器内 whisper**。[已验证/子代理]

**E. Barge-in —— 优先级 + 意图机制**
- `packages/pipelines-audio/src/speech-pipeline.ts`：意图行为 `queue|interrupt|replace` + 优先级（critical 300/high 200/normal 100/low 0）。`interrupt` 当新优先级≥活动优先级才打断；每段读取检查 `intent.canceled || controller.signal.aborted`。[子代理]
- `managers/playback-manager.ts`：`maxVoices` + `overflowPolicy(queue|reject|steal-oldest|steal-lowest-priority)`，`stopByIntent()` 取消该意图全部播放。[子代理]
- **VAD `speech-start` → 打断 TTS 的接线**子代理未在代码中直接定位（推测在 store 层 `speech-output-control.ts requestStopSpeaking`）。[推断]

**F/G. 输出/架构** —— `processors/tts-chunker.ts`：`minimumWords=4 / maximumWords=12 / boost=2`(前 2 段提前出) + 标点切 + narrative 剥离(`*动作*`/`[旁白]`)；半双工，BroadcastChannel 跨 tab 事件总线。[子代理]

---

### 1.4 ZerolanLiveRobot + zerolan-core — 轻量 WebRTC-VAD，**无 barge-in（纯半双工）**

根：`…neuro/ZerolanLiveRobot/` + `…neuro/zerolan-core/`

**A. 采集** —— `devices/microphone.py`：**PyAudio**，16kHz/单声道/paInt16，chunk = `16000*frame_duration/1000`（默认 30ms=480 样本，因 WebRTC-VAD 要求 10/20/30ms 帧）。专用 KillableThread "VADThread" 循环读。[子代理]

**B. VAD —— WebRTC-VAD**：`webrtcvad.Vad(vad_mode)`，默认 mode=3（最激进），`is_speech()` 逐帧判。[子代理]

**C. EOU** —— VAD 静音即结束（无 hangover/无静音时长阈值，说话→静音转换立即 `_emit_event()` 出整段 WAV）；可 F8 热键 push-to-talk 控制麦克风开关。[子代理]

**D. STT** —— 默认 **Paraformer**（zerolan-core，中文 16kHz，**支持 chunk 流式** `stream_predict`，~600ms/块）；备选 Whisper(`whisper-1`，无流式)、Baidu(伪流式)、Kotoba-Whisper(日语)。[子代理]

**E. Barge-in —— 无（明确半双工）**：`speaker.stop_now()` 存在但**从不在收到麦克风输入时调用**；TTS 入队顺序播放、阻塞式 `playsound(block=True)`，麦克风 VAD 与 TTS 播放并行但**互不耦合**，用户无法打断。[子代理]

**F/G. 输出/架构** —— GPT-SoVITS(默认，stub)/Baidu TTS；可选 `enable_clause_split` 按标点切句、TTS 线程池(max_workers=1 串行)。事件驱动 `TypedEventEmitter`，半双工。[子代理]

> **对 chat-A 的意义**：Zerolan 是「树莓派级最简实现」的参照——WebRTC-VAD（极轻、纯能量/频谱、无需 ONNX）是 Silero 的低算力退路；但它**牺牲了 barge-in**，正是 chat-A 不应接受的取舍。

---

### 1.5 voice-core（本地） — 能量 VAD + faster-whisper + CancellationToken 打断

根：`reference/voice-core/voice-core-main/`（输出侧 streaming_utils/tts.py 已在既有文档覆盖）

- **A 采集**：`ears/stt.py` `sounddevice.InputStream(samplerate=16000, channels=1, blocksize=512)`（~32ms/块），回调流入 `AudioSegmentBuffer`。[子代理]
- **B VAD**：faster-whisper 内置 `vad_filter` + **能量阈值**状态机（`VADState` SILENCE→SPEECH→COMPLETE）；`energy=np.sqrt(np.mean(indata**2))`，`vad_threshold` 默认 0.5，**TTS 播放时乘 `echo_prevention_multiplier` 抬高阈值防回声**。[子代理]
- **C EOU**：尾随静音 `silence_counter >= silence_threshold`(由 `silence_duration` 默认 1.5s 换算)→ COMPLETE → 取段转写。无语义 EOU。[子代理]
- **D STT**：faster-whisper，可选流式 partial（`enable_streaming`/`WHISPER_PARTIALS`），默认整段。[子代理]
- **E Barge-in**：`orchestrator.py` `_interrupt_current_operation()` 新语音→取消在途 TTS、清音频/句队列；`CancellationToken` 串 LLM/TTS/playback；`play_audio_interruptible()` 回调里查 token。[子代理]
- **G 架构**：半双工（is_speaking_flag 抬 VAD 阈值防回声）；多线程 Listener/Processor/TTS/Playback。[子代理]

---

### 1.6 voice-infra（LiveKit Agents + Pipecat） — 工业级编排参照

根：`reference/voice-infra/`（LiveKit filler/endpointing/preemptive 已在既有文档覆盖，本节补 VAD/STT/打断接口面）

**LiveKit Agents**
- **VAD（Silero 插件）** `livekit-plugins/livekit-plugins-silero/.../vad.py`：`activation_threshold=0.5`、`deactivation_threshold=max(0.5-0.15,0.01)`、`prefix_padding_duration=0.5s`、`min_speech_duration=0.05s`、`min_silence_duration=0.55s`、`max_buffered_speech=60s`，支持 8/16kHz。[子代理]
- **EOU `DynamicEndpointing`** `voice/endpointing.py`：`ExpFilter`(EMA α=0.9) 学「句内停顿」与「轮间停顿」，动态调 min/max delay；`_AGENT_SPEECH_LEADING_SILENCE_GRACE_PERIOD=0.25s`。**chat-A voice-detect 即采用此同源算法。** 另有独立的语义 turn-detector 插件可选。[子代理]
- **STT `stream_adapter.py`**：VAD 把非流式 STT 包成「START_OF_SPEECH → 累积 → END_OF_SPEECH 调 recognize → FINAL」；原生流式 STT（如 Deepgram）走 provider，出 interim。[子代理]
- **Barge-in** `voice/agent_activity.py`：`min_interruption_words` / `min_interruption_duration` 确认真打断；`AgentFalseInterruptionEvent` + `_false_interruption_timer` 处理误打断回滚 `_paused_speech`。[子代理]

**Pipecat**
- 帧管线：`AudioFrame` 流经 VAD(`VADAnalyzer`，`VADParams confidence=0.7/start_secs=0.2/stop_secs=0.2/min_volume=0.6`，状态 QUIET/STARTING/SPEAKING/STOPPING) → TurnAnalyzer(含 `SmartTurn` 语义 EOU 本地模型) → LLM → TTS。[子代理]
- **打断** `InterruptionFrame` 上下游广播；`UninterruptibleFrame`(EndFrame/StopFrame/FunctionCallResultFrame 免打断)；**全双工潜力**（帧双向）。[子代理]

---

### 1.7 realtime-voice-agent-demo（本地） — 适配器化、Deepgram 原生流式 STT

根：`reference/github-projects/realtime-voice-agent-demo/realtime-voice-agent-demo-main/backend/app/`

- **采集**：WebSocket 二进制 PCM 16kHz 入 `audio_q` 队列（`main.py`）。[子代理]
- **VAD/STT**：双适配器。**Deepgram**(`adapters/stt/deepgram.py`)：`AsyncLiveClient` 原生流式，`interim_results=True`，服务端出 `is_final`（**EOU 由云端给**），`model=nova-3, language=multi`。**Whisper**(`adapters/stt/whisper.py`)：本地**能量 VAD**——`_SILENCE_RMS=0.012`、`_FRAME_MS=32`(512 样本)、`_SILENCE_HANG_MS=600`、`_MIN_SPEECH_MS=300`，尾随静音 600ms 关轮，可选 partial(`WHISPER_PARTIALS=1` 重转写增长 buffer)。[子代理]
- **Barge-in**：`main.py` `cancel_response()`——新 final transcript 到达 / 客户端 interrupt → `response_task.cancel()` → 发 `{"phase":"interrupted"}`；**已生成文本在 `_respond()` 的 finally 里写回历史**（半句保留）。[子代理]
- **架构**：半双工，`response_task` 生命周期即状态机；适配器接口（STT/TTS/LLM 各 base + 多 provider）是干净的「五类后端 Factory」范例，与 chat-A embedded-lightweight 接缝思路一致。[子代理]

---

## 2. 横向对比表（输入侧 5 维 + 双工）

| 项目 | VAD | EOU / 端点检测 | STT 流式/partial | Barge-in 打断 | 双工 |
|---|---|---|---|---|---|
| **OLV** | Silero(prob 0.4 + dB 60, hit3/miss24) | VAD 静音 ~0.77s | faster-whisper 等多引擎，**整段无 partial** | **有**：cancel 回合+清队列+半句标 `[Interrupted]` 回上下文；VAD 自动打断 | 半双工 |
| **RealtimeVoiceChat** | Silero(via RealtimeSTT, sens 0.05)+WebRTC 兜底 | **语义 EOU**：DistilBert 句完整度→动态静音(0.65 标点+0.35 模型, min 0.6s) | RealtimeSTT/faster-whisper **有 partial(30ms)** | **工业级**：多 worker abort+5s 超时+清播放缓冲+半句回存+**相似度 0.95 防误打断** | 半双工(VAD 门控) |
| **airi** | **Silero(transformers.js 浏览器内)** 0.3/迟滞 0.1，静音 400ms，pad 80ms | VAD redemption(静音 400-800ms) | 云 **阿里云 NLS**，`enable_intermediate_result` 有 partial | **优先级/意图机制**(queue/interrupt/replace + 优先级阈值)；VAD→打断接线未直接见 | 半双工 |
| **ZerolanLiveRobot** | **WebRTC-VAD** mode3(轻量) | VAD 静音即结束(无 hangover)；F8 PTT | Paraformer 中文 **chunk 流式~600ms**；Whisper/Baidu 无流式 | **无（纯半双工）** | 半双工 |
| **voice-core** | 能量阈值(0.5)+whisper vad_filter，播放期抬阈防回声 | 尾随静音 1.5s | faster-whisper 可选 partial | **有**：CancellationToken 串 LLM/TTS/playback+清队列 | 半双工 |
| **voice-infra/LiveKit** | Silero 插件(0.5/0.35, pad 0.5s, minSil 0.55s) | **DynamicEndpointing 双 EMA(α0.9)** + 语义 turn-detector 可选 | stream_adapter(VAD 包整段)/provider 原生 interim | **有**：min_interruption_words/duration + 误打断回滚 | 半双工(全双工潜力) |
| **voice-infra/Pipecat** | VADAnalyzer(conf 0.7/start0.2/stop0.2) | **SmartTurn 语义 EOU 本地模型** | provider 流式 | **有**：InterruptionFrame 广播 + UninterruptibleFrame | **全双工潜力** |
| **realtime-demo** | Deepgram 原生 / Whisper 能量(RMS 0.012, hang 600ms) | 云端 is_final / 静音 600ms | **Deepgram 原生流式 interim** / Whisper 可选 | **有**：response_task.cancel()+半句写回 | 半双工 |
| **chat-A 现状** | 自有 voice-detect | **双 EMA 动态 endpointing(同 LiveKit)** ✅ | **qwen3-asr-flash 整段 multipart 无 partial** ❌ | **无** ❌ | 半双工 |

**收敛观察**：
- **VAD**：Silero VAD 是事实标准（5/8 项目）；WebRTC-VAD 是低算力退路；能量阈值是最简兜底。
- **EOU**：基础都是「VAD 静音时长」；进阶有两条路——(a) LiveKit/chat-A 的**双 EMA 动态静音**，(b) RVC/Pipecat 的**语义 EOU 模型**（判句子完整度）。两者可叠加。
- **STT partial**：云服务(Deepgram/阿里 NLS) 与 RealtimeSTT 天然有 partial；自托管 whisper 默认整段、需额外重转写才出 partial。chat-A 当前**无 partial**。
- **Barge-in**：除 Zerolan 外**全部实现**；最完整的是 RVC（含相似度防误打断）与 LiveKit（min_interruption_words/误打断回滚）。半句回上下文是 OLV/RVC/demo 的共识做法。

---

## 3. 对 chat-A 的可落地建议（输入侧优先，按优先级）

> chat-A 已有：双 EMA 动态 endpointing（第一梯队，**维持**）、半双工 VoiceLoop 骨架、AbortSignal 真取消（见 memory voice-pipeline-state）。下列聚焦**缺口**。

### ★P0 — Barge-in（用户开口打断正在播放的 TTS）：chat-A 最大输入侧缺口
chat-A 已有 AbortSignal 真取消的底座，barge-in 是「把 VAD 的 speech-start 接到这个 AbortSignal 上」。**推荐直接抄 OLV + RVC 的成熟模式**：
1. **检测**：播放 TTS 期间保持 VAD 在线（半双工门控即可，不必全双工）；VAD `speech-start` 触发打断。**务必带回声防护**——参考 voice-core「播放期抬高 VAD 阈值(`echo_prevention_multiplier`)」或 RVC「客户端随帧上报 isTTSPlaying flag」，否则会被自己的 TTS 触发误打断。
2. **停**：触发现有 AbortSignal → 停 LLM/TTS run-task（CosyVoice `finish-task`/qwen close）+ **清播放队列 + 丢弃在途 PCM**（RVC 客户端 worklet `clear` 思路）。
3. **半句回上下文**：把已朗读的部分以 assistant 消息写回历史并标 `interrupted`（OLV `[Interrupted by user]` / demo finally 写回）——**这正契合 canonical「被打断是伴侣特征非 bug，人格可对被打断产生反应」**。
4. **防误打断**：加 RVC 式护栏——`min_interruption_words`/`min_interruption_duration`（LiveKit）或 partial 相似度阈值（RVC 0.95），避免「嗯」「啊」一声把回复打断。chat-A 无 partial，先用 min-duration（如开口持续 >300ms 才算真打断）最易落地。

> 适配 chat-A：树莓派+PC、低延迟、可降级。barge-in 是**纯事件接线**，几乎零额外算力，应**最高优先**落地。

### ★P1 — 语义 EOU（在双 EMA 之上叠一层「句子说完了没」）：少等不抢话
chat-A 的双 EMA 已能学停顿分布，但**纯停顿无法区分「停顿在想词（没说完）」与「真说完」**。RVC 的 `KoljaB/SentenceFinishedClassification`(DistilBert) 正解此问题：
- **做法**：用一个轻量句完整度分类器，对 STT 当前文本算「完整概率」，按 `anchor (0→1.0s, 1→0s)` 收放静音等待，与现有 EMA **加权融合**（RVC 用 0.65 标点 + 0.35 模型）。
- **chat-A 取舍**：DistilBert 是英文且要 transformers 运行时，**树莓派偏重**。建议：(a) PC 端可上轻量 EOU 模型；(b) 树莓派端先用**标点/语气词启发式**（中文「吗/呢/吧/啊」结尾 + 句末标点 → 高完整度，缩短静音；「然后/那个/就是」等 filler 结尾 → 低完整度，延长静音）逼近同效果，零模型成本。**优先级低于 barge-in**，因现有 EMA 已可用。

### ★P1 — STT 流式 partial：解锁预测性生成与更快 EOU
chat-A `qwen3-asr-flash` 走 multipart **整段上传**，是「无 partial」的根因，**卡死了两个降延迟红利**：(a) partial 驱动的预测性生成（canonical/既有文档 §7 已设计但「语音输入路才用得上」）；(b) partial 驱动的语义 EOU。
- **动作**：调研 qwen ASR 是否有 **realtime/流式 WS 接口**（参照 qwen-tts-realtime/omni-realtime 已通的 WS 模式）；若有，切到流式出 partial。若云端只有整段接口，**退路**：本地 faster-whisper/sherpa-onnx 流式（OLV/voice-core 已验证可行，且 sherpa-onnx 对树莓派友好），出 interim。
- 优先级：中——是「再进一步」的基础设施，但 barge-in/EOU 不强依赖它即可先落地（barge-in 用 VAD 即可，EOU 可用整段文本）。

### P2 — VAD 后端 Factory 锚点：Silero(PC) / WebRTC-VAD(树莓派) 双轨
chat-A 有自有 voice-detect，**不必替换**；但参考项目高度收敛于 Silero，建议在 voice-detect 的后端接缝（embedded-lightweight Factory）**预留 Silero(ONNX) 与 WebRTC-VAD 两个实现**：PC 用 Silero（精度高、误触发低），树莓派用 WebRTC-VAD（Zerolan 实证极轻）。前后静音填充(pad)参数对齐参考值：speechPad 80ms（airi）/ prefix 0.5s（LiveKit），min_silence 0.4~0.55s。

### P3 — 回声防护（barge-in 的前置依赖，单列强调）
barge-in 一旦开启，**回声/自激是头号坑**。三种成熟手法可选/叠加：
1. 浏览器/采集层 `echoCancellation:true`（airi/RVC 都开）；
2. 播放期动态抬高 VAD 阈值（voice-core `echo_prevention_multiplier`，半双工最简）；
3. 随音频帧上报 isTTSPlaying flag，服务端据此抑制（RVC）。
chat-A desktop(Electron) 可优先用 (1)+(2)。

---

## 4. 落地优先级速查

| 优先级 | 动作 | 主要参考 | 算力/复杂度 | chat-A 现有底座 |
|---|---|---|---|---|
| **P0** | **Barge-in**：VAD speech-start → AbortSignal 停 TTS+清队列+丢在途+半句回存 | OLV `conversation_handler`、RVC `process_abort_generation`、demo `cancel_response` | 低（纯接线） | AbortSignal 真取消已有 ✅ |
| **P0 内** | 防误打断护栏（min-duration / 相似度） | RVC 0.95 相似度、LiveKit min_interruption_words | 低 | — |
| **P0 内** | 回声防护（抬阈/EC/flag） | voice-core 抬阈、RVC flag、airi EC | 低 | Electron 可用 EC |
| **P1** | 语义 EOU 叠加双 EMA（PC 上模型 / 树莓派上启发式） | RVC `turndetect.py`、Pipecat SmartTurn | 中(PC)/低(启发式) | 双 EMA endpointing 已有 ✅ |
| **P1** | STT 流式 partial（qwen ASR realtime / 本地 sherpa-whisper 退路） | demo Deepgram、OLV faster-whisper、RVC RealtimeSTT | 中 | qwen WS 模式经验已有 |
| **P2** | VAD 后端 Factory：Silero(PC)/WebRTC(树莓派) | OLV/airi/LiveKit Silero、Zerolan WebRTC | 低 | voice-detect + Factory 接缝 |

---

## 5. 拿不准 / 待确认

- **[待确认]** qwen3-asr-flash 是否提供流式/realtime WS 接口出 partial（决定 P1 STT 流式走云还是退本地）。需查 DashScope ASR 文档/实测。
- **[待确认]** RVC 的 DistilBert EOU 模型为英文，中文场景需换中文句完整度模型或启发式；chat-A 中文为主，**语义 EOU 直接照搬不可行**，需中文方案。
- **[子代理未直读]** airi「VAD speech-start → 打断 TTS」的确切接线代码未在 pipeline 层定位（推测在 store/speech-output-control），若要细抄需再查。
- **[子代理]** 本文除已标 [已验证] 的 OLV/RVC/airi VAD 参数与 RVC 模型名/anchor/weight（已 grep/sed 核实）外，多数 file:line 来自并行子代理汇报，机制结论可信、行号可能少量偏差，细抄前建议复读对应文件。
- **[经验值]** barge-in 防抖的 min-duration（~300ms）为业界经验，chat-A 需按人格/场景实测校准（伴侣语境下「嗯/对」可能本就是有意义的 backchannel，打断阈值不宜过敏感）。

---

## 主要证据文件（输入侧）

- **OLV**：`…neuro/Open-LLM-VTuber/src/open_llm_vtuber/vad/silero.py:9,17-20,46,79-189`、`websocket_handler.py`(_handle_audio_data/_handle_interrupt)、`conversations/conversation_handler.py`(handle_individual_interrupt)、`conversations/tts_manager.py`(clear)、`asr/asr_factory.py`。
- **RealtimeVoiceChat**：`…neuro/RealtimeVoiceChat/code/turndetect.py:13,18-21,218-219,478-480`、`transcribe.py:21,28-34,37,56-58,250,338`、`speech_pipeline_manager.py`(process_abort_generation/check_abort)、`server.py`(on_recording_start/send_final_assistant_answer)、`audio_in.py`、`static/app.js`(isTTSPlaying flag)。
- **airi**：`…neuro/airi/apps/stage-web/src/workers/vad/vad.ts:4,27-31,50,196-197`、`process.worklet.ts`、`apps/server/src/routes/audio-transcription-stream/session.ts`(Aliyun NLS)、`packages/pipelines-audio/src/{speech-pipeline.ts,managers/playback-manager.ts,processors/tts-chunker.ts}`、`composables/audio/audio-device.ts`。
- **ZerolanLiveRobot**：`…neuro/ZerolanLiveRobot/devices/microphone.py`、`devices/speaker.py`、`pipeline/asr/{whisper_asr.py,baidu_asr.py,config.py}`、`zerolan-core/asr/paraformer/model.py`、`bot.py`、`event/event_emitter.py`。
- **voice-core**：`reference/voice-core/voice-core-main/ears/stt.py:32-37,234,259-322,469-486`、`orchestrator/orchestrator.py:152-166`、`voice/tts.py:264-372`。
- **voice-infra**：`reference/voice-infra/agents/livekit-plugins/livekit-plugins-silero/livekit/plugins/silero/vad.py`、`agents/livekit-agents/livekit/agents/voice/{endpointing.py,agent_activity.py}`、`agents/livekit-agents/livekit/agents/stt/stream_adapter.py`、`pipecat/src/pipecat/audio/{vad/vad_analyzer.py,turn/}`。
- **realtime-demo**：`…/realtime-voice-agent-demo-main/backend/app/{main.py,adapters/stt/deepgram.py,adapters/stt/whisper.py}`。
- 既有本仓文档（输出侧/底层）：`docs/streaming-fast-response-findings-2026-06-25.md`、`voice-pipeline-findings-2026-06-23.md`、`voice-loop-findings-2026-06-23.md`、`voice-infra-findings-2026-06-22.md`、`voice-module-issues-2026-06-25.md`、`chat-a-canonical-design.md`(§3.2/§4)。
