# 实时语音 infra 深读发现:LiveKit Agents / Pipecat(2026-06-22)

> 方法:克隆 `livekit/agents`(Python,编排式)+ `pipecat-ai/pipecat`(Python,帧管线式)到 `reference/github-projects/voice-infra/`,逐文件精读真实代码,对照 chat-A §4。
> **架构决策**:采用 **Pipecat 帧管线**作为 runtime 内部流式骨架(取代早期 Nexus 帧管线构想);分层见 canonical §4.2(帧管线管 runtime 内 / 事件总线管跨模块)。
> 标注:🆕=应纳入的增量 | ✅=确认 | ⚠️=坑/裸 WebSocket 缺口。

## 1. 两条路线性格
- **LiveKit Agents = 编排式**:`AgentSession → AgentActivity → AudioRecognition` 三层,优先级堆(`heapq`)串行调度回合。强在轮次/打断/预测生成算法;**深绑 WebRTC + LiveKit 云推理网关**。
- **Pipecat = 帧管线式**:`FrameProcessor` 链 + 帧分类调度,传输无关。强在可组合骨架;打断/顺序播放/过滤都是"帧在链上流动"的统一原语。

## 2. Pipecat 帧管线骨架(已采用,B 层)
- 🆕 **四态帧模型**(`src/pipecat/frames/frames.py:99-152`):`SystemFrame`(高优先、不受打断、插队)/ `DataFrame`/`ControlFrame`(顺序、打断丢弃)/ `UninterruptibleFrame` mixin(打断也送达,如 `EndFrame`/`FunctionCallResultFrame`)。每帧自带 `id/name/pts/metadata/transport_source/broadcast_sibling_id`(天然 correlation 字段)。
- 🆕 **双队列双任务调度**(`frame_processor.py:119-167,1007-1053`):`__input_queue`=PriorityQueue(System=HIGH/其余=LOW,同优先级单调计数器保 FIFO),input task 立即处理 System、其余丢 `__process_queue`(FIFO)由 process task 顺序处理。背压靠 `asyncio.Queue` + `pause/resume_processing_frames`(`:606-630`)。
- 🆕 **打断 = `InterruptionFrame` 双向广播 + 队列 reset**(`frame_processor.py:735-741,853-878`;`frame_queue.py:82-93` reset 保留 uninterruptible、`has_uninterruptible` O(1) 计数)。⚠️ 本版只有单一 `InterruptionFrame`,无 Start/Stop(旧资料有误)。
- 🆕 **输出音频 10ms 切片 + wall-clock 配速**(`base_output.py:123-135,567-592`;`fastapi.py:578-587`):16k mono 10ms=320B,默认 40ms 批。**中途干净打断的物理前提**。⚠️ WS 出站 `_send_interval=chunk/sr/2`(故意半速喂客户端 jitter buffer)。
- ✅ **传输无关接缝**(`base_transport.py:92-133`):`input()/output()` 各返回一个 FrameProcessor;换传输只换这俩。对应 chat-A AudioTransport(接缝1)。
- 🆕 **VAD 双门 + 帧计数确认**(`vad_analyzer.py:30-44,189-243`):confidence≥0.7 **且** volume≥0.6 才算说话,start/stop_secs 转帧计数去抖。⚠️ Silero 仅 8k/16k、固定 512 样本@16k(32ms)。
- 🆕 **轮次策略可插拔**(`turns/`):VAD/Transcription start 策略 + TurnAnalyzer stop 策略;用户 turn 一开始即 `broadcast_interruption()`。Smart Turn **v3**(`local_smart_turn_v3.py`,Whisper 80 维 log-mel/8s 窗/sigmoid>0.5)。端点 = VAD stop → 跑 turn 模型 → 等转写 finalize 或 `stt_p99-vad_stop` 兜底。
- 🆕 **打断时部分 assistant 文本写回上下文**(`llm_response_universal.py:1609-1611`,标 `interrupted=true`)——伴侣"我刚说到一半"连贯性关键。
- 🆕 **Observer 旁路 + 三层 OTel span**(`observers/base_observer.py`、`utils/tracing/`):`conversation_id→turn.number→service span`,每帧流转旁路记录、frame.id 去重、ns 时间戳——直击 §8.1。
- ⚠️ 坑:`has_frame()` O(n) 别热路径调;打断靠 cancel asyncio task(吞 CancelledError 会挂,有 3s 超时兜底);`StartFrame` 必须先于一切数据帧贯穿全链。

## 3. LiveKit Agents 的算法增量(落 B/C 层)
- 🆕⭐ **预测性生成(preemptive generation)**(`voice/agent_activity.py:2022,2061,2248-2268`):STT interim/final 一变就先跑 LLM 不出声、缓存快照;轮次确认后比对**输入指纹**(transcript+`chat_ctx.is_equivalent`+tools+tool_choice),命中复用(吃掉 LLM 首字延迟)、未命中 abort 重跑。护栏:`max_retries=3`/`max_speech_duration=10s`/默认不投机 TTS(`turn.py:205-216`)。**误打断之外的另一半延迟红利**。
- 🆕⭐ **EOU 概率反向驱动动态 endpointing**(`audio_recognition.py:1306,1394-1399`;`endpointing.py:49`):`prob<unlikely_threshold`(用户没说完)→ 把静音窗从 `min_delay` 拉到 `max_delay`;`DynamicEndpointing` 用两个 EMA(α=0.9)分别学句内/轮间停顿。纯 CPU 可移植。本地 EOU = Q8 ONNX(`onnxruntime`),取最近 6 轮、per-language 阈值(中文 0.3550)。
- 🆕 **三道授权闸门**(`agent_activity.py:2801-2838`):scheduled → authorized(+activity 级全局闸)→ **用户静音才授权出声**;每关后查 `interrupted` 即 `cancel_and_wait`。= chat-A abort 三件套同构,增量是"LLM 已跑但 TTS 出声前可无损撤销"+"用户静音才开口"。
- 🆕 **自适应打断 + 先 pause 后定夺**(`agent_activity.py:1781,1945`;`turn.py:173-178`):打断先 `audio_output.pause()` 不销毁 → 起 `false_interruption_timeout=2s` → 真打断才丢、否则 `resume()`;`backchannel_boundary`(默认 1s/1s)起止冷却抑制附和;`min_words`+`min_interruption_duration=50ms` 三重抑制 false-barge-in。⚠️ 附和/打断分类是**云端 ML 模型**,无开源本地版 → chat-A 初期用 VAD+min_words+min_duration+backchannel_boundary 启发式降级。
- 🆕 **段级并发 TTS**(`agent_activity.py:2742-2760`):LLM 流遇 `FlushSentinel` 切段,**下段合成在上段播放期间就开始**(单飞 `await prev_tts_task` 但提前启动)。
- 🆕 **工具调用与说话交错**(`generation.py:526,779`):function channel 实时取调用并行起 task;工具可标 `CANCELLABLE`;多步回合 `_num_steps`/`_generation_id` 追踪。
- 🆕 **per-message MetricsReport + user_turn span 树**(`llm/chat_context.py:261-313`、`telemetry/trace_types.py`):`ttft/ttfb/transcription_delay/end_of_turn_delay/playback_latency/e2e_latency` 指标字典——§8.1 现成模板。

## 4. ⚠️ chat-A 用裸 WebSocket 必须自建的(LiveKit 靠 WebRTC/云推理白嫖)
- **逐帧时间戳/采样率**:EOU/打断/transcription_delay 全靠帧自带时间基准(`audio_recognition.py:651` `_input_started_at = time - frame.duration`);PCM-over-WS 要自带逐帧时间戳。
- **AEC / agent 说话时门控 STT**:LiveKit 开口初期 `_aec_warmup_remaining` 把送 STT 的帧替静音防自打断(`agent_activity.py:1148-1176`);树莓派+裸 WS **必须自建 AEC 或等价门控**,否则误打断暴增。
- **客户端播放游标回传**:打断后要知道"实际播到哪几个字"(LiveKit `PlaybackFinishedEvent.synchronized_transcript`),否则写回上下文的 assistant 文本与用户听到的不一致。
- **本地推理**:EOU 用 mini ONNX 可行(契合树莓派+优雅降级);附和/打断分类无本地版,初期启发式降级。

## 5. 最值得加进 §4 的(优先级)
1. ⭐ 预测性生成 + 输入指纹复用(护栏必带)。
2. ⭐ EOU 概率驱动动态 endpointing(两个 EMA,纯 CPU)。
3. ⭐ Pipecat 四态帧 + 双队列骨架(已采用,B 层)。
4. 先 pause 后定夺打断 + 半句写回上下文 + backchannel 冷却。
5. 10ms 切片 + wall-clock 配速 + TTS 关 context 不断连。
6. Observer + conversation/turn/service OTel span(§8.1)。

## 6. OpenTelemetry 深读(对照 §8.1 可追溯/可观测)
> 信源:WebFetch OTel GenAI 属性 registry + traces 概念 + `@opentelemetry/context-async-hooks`(成功);GenAI spans/JS-context 子页被重定向未取到原文(下列内容据 registry + 两本地实现)。本地读 Pipecat `utils/tracing/` + LiveKit `telemetry/`。

- 🆕 **OTel JS 的默认 context manager = `AsyncLocalStorageContextManager`(基于 Node `AsyncLocalStorage`)**——chat-A 采用的"AIRI 式 traceId 总线"就是它。→ **直接用 `@opentelemetry/sdk-node` 当骨架,不自造**(context 传播/span 树/W3C traceparent 现成)。旧 `AsyncHooksContextManager` 已弃用。
- 🆕 **两层,同 ID 缝合**:OTel trace(实时·可采样·span 默认不存完整 prompt)vs SQLite 决策 trace(持久·全量·可重放)——LiveKit 的事实架构(span 给观测、**log 信号**做持久 SessionReport/chat_history,`traces.py`),chat-A 把"log 信号上传"换成"写本地 SQLite"即可。SQLite record 存 `trace_id/span_id`;**可重放靠 SQLite 全量,不靠 OTel(采样会丢)**。
- 🆕 **GenAI 语义约定属性**(registry verbatim,⚠️ 全 Development 级会变、锁版本):`gen_ai.operation.name`(chat/embeddings/execute_tool…)、`gen_ai.provider.name=anthropic`、`gen_ai.request.{model,max_tokens,temperature,top_p}`、`gen_ai.usage.{input_tokens,output_tokens}`、`gen_ai.response.{id,model,finish_reasons}`、`gen_ai.output.type`(语音用 **`speech`**)、`gen_ai.conversation.id`(=sessionId)、`gen_ai.{system_instructions,input.messages,output.messages,tool.name,tool.call.id}`。
- 🆕 **三信号映射**:chat-A `metric`→OTel metric(LiveKit `otel_metrics.py`:`lk.agents.turn.{e2e_latency,llm_ttft,tts_ttfb}` Histogram + `usage.*_tokens` Counter,可直接抄);`error`→span.status=ERROR + `record_exception`(冗余写 `exception.{type,message,stacktrace}` 属性,防 event 不渲染);`event`→span events 或 log 信号。
- 🆕 **延迟锚定真实时刻**:Pipecat TTS/STT span 用 `start_time/end_time` 锚到语音真实发生时刻(非协程恢复时刻);TTFT/TTFB 既作 span 属性又作 metric。
- 🆕 **落地扩展点**:Pipecat `setup.py` 的 `tracer_provider.add_span_processor(...)` → chat-A 自写一个**写 SQLite 的 SpanProcessor/Exporter**,复用 OTel 骨架但真相留本地。
- ⚠️ **隐私/坑**:OTel 默认不记 prompt 内容 ↔ §8.1 debug 要完整 prompt → **完整 prompt 只在 debug 级 + 落本地 SQLite(不导出 OTLP)+ 过脱敏接缝**(Pipecat `adapter.get_messages_for_logging` 先例);大 prompt 别塞 span 属性;跨 asyncio task 纯 ALS 会断,需显式存 turn SpanContext 兜底(Pipecat `tracing_context.py`);**树莓派上 flush/shutdown 加硬超时**(LiveKit `traces.py` 踩过 30–90s 卡顿)。
- 关键文件:Pipecat `src/pipecat/utils/tracing/{service_attributes,service_decorators,turn_trace_observer,tracing_context,setup}.py`;LiveKit `livekit-agents/livekit/agents/telemetry/{trace_types,traces,otel_metrics}.py` + `voice/generation.py`。

## 关键文件索引
- LiveKit:`agents/livekit-agents/livekit/agents/voice/{agent_activity,audio_recognition,generation,speech_handle}.py`、`.../turn_detector/{base,turn,endpointing}.py`、`.../inference/eot/`、`.../telemetry/`。
- Pipecat:`pipecat/src/pipecat/frames/frames.py`、`.../processors/frame_processor.py`、`.../transports/base_{transport,output}.py`、`.../audio/vad/`、`.../audio/turn/`、`.../services/*/tts.py`、`.../observers/`、`.../utils/tracing/`。
- 源码克隆见 `reference/github-projects/voice-infra/`(README 索引)。
