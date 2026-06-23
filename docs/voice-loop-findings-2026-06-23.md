# VoiceLoop 语音回合骨架设计依据（5 路调研汇总,2026-06-23）

> 5 路并行调研:① 端到端实现(voice-core/RealtimeVoiceChat/realtime-demo)② Pipecat ③ LiveKit Agents ④ 通用 turn-taking 状态机模式 ⑤ 伴侣/框架(Open-LLM-VTuber/TEN/Vocode)。五份**高度收敛**。本文为 chat-A 端到端语音回合(VoiceLoop)组装的设计依据,供后续 brainstorming/spec。

## 0. 一句话结论
**chat-A 的"想"(Conversation.send:人格/PAD/closeness/三层记忆+语义召回/反对)已比所有调研对象都重。VoiceLoop 只需做一个薄外壳:听 → Conversation.send → 说,+ 打断 + 主动开口。** 范式抄 **Open-LLM-VTuber 的"回合即一个可取消 asyncio.Task"**;**不抄** Vocode 常驻 worker / TEN 图 runtime(C++/Agora,树莓派+Node 太重)/ RealtimeVoiceChat 多线程(嵌入式太重)。

## 1. 编排范式(已收敛)
- **半双工 + 事件驱动,无中央 while 循环**。一轮 = 一个可取消 `asyncio.Task`(OLV `current_conversation_tasks[uid]`;demo `response_task`)。打断 = `task.cancel()` + `except CancelledError` 兜底。
- **VoiceLoop = 薄外壳包住 Conversation.send**:
```
[AudioTransport 接缝1] 收音频帧(16k/mono/s16le)
 → voice-detect(Silero VAD 状态机)→ 段末 EOU
 → 回合调度入队(用户=URGENT)         ← §7 单消费者优先级队列(= OLV current_conversation_tasks)
 → runTurn(可取消 task):
      STT(Provider 工厂) 
      → Conversation.send(batchInput) ← chat-A 已有"完整一轮"(PromptContributor §5.4 组装)
           · 产出 AsyncIterator<句级输出>
      → 逐句 TTS(Provider 工厂,首句优先 faster_first_response)→ AudioTransport 下发
      → 落记忆/历史
```
- **句级流式**(三家都有):Conversation.send 应产 `AsyncIterator`,VoiceLoop 逐句送 TTS、首句优先 → 压首字延迟。可直接搬 voice-core `SentenceSplitter`(缩写表+max_chars 防 TTS 溢出+fallback)。

## 2. 状态机(已收敛)
- **正交双状态(LiveKit)** 或 **四态(通用)**,二选一融合,建议:
  - **UserState**: `listening | speaking | away`
  - **AgentState**: `idle | listening | thinking | speaking`(+ 瞬态 `interrupting`)
  - 或合并视图四态:`LISTENING → ENDPOINTING → THINKING → SPEAKING`(+ 跨在 SPEAKING 上的瞬态 **BARGE-IN PENDING**)。
- **建议把 BARGE-IN PENDING 做成命名状态**(非 SPEAKING 内隐式分支),迁移/timer 清晰可测。
- **状态迁移 = chat-A §4.2.1 已定义的 A 层 BusEvent**(`turn:start/end`/`vad:speech_start/end`/`stt:final`/`tts:first_audio`/`turn:interrupt`)——一一对应,天然可追溯。帧级 token/chunk 留 B 层不上总线。
- `thinking↔speaking` 切换点 = "LLM 调用前" / "TTS 首帧";chat-A 主动/反对可挂 agent_state 迁移钩子。

## 3. 回合令牌 / generation(已收敛)
- **SpeechHandle 等价物**(LiveKit):`Conversation.send`/runTurn 应返回**句柄**(含 `scheduled/authorized/interrupted/done` Future + 优先级 LOW/NORMAL/HIGH + 多步 num_steps 供工具链),而非即发即忘。优先级:主动话题=LOW、回应=NORMAL、紧急/安全=HIGH。
- **generation 标签**(voice-core 模式 A):每回合 `generation_id+1`,产出帧打标;TTS/播放只接受 ==current 的帧,旧的静默丢弃(无需强杀;与 P-1 帧管线天然契合)。
- **AgentActivity 随 Agent 切换**(LiveKit)= 模块级爆炸半径可控(契合模块化原则);换人格=换编排活动对象。

## 4. 打断 / barge-in(已收敛 + 落地数字)
- **触发**:VAD/EOU 声学先于 transcript 判;最小持续守卫 200-300ms 防误触;启动冷却 1.0s(agent 开口首 1s 抑制自适应打断,改用 VAD)。
- **执行(服务端三件 + 客户端一件)**:① `task.cancel()` 停生成/TTS;② AudioTransport `clear_buffer()` 排空已缓冲音频;③ `wait_for_playout()` 回报**实际播放位置**;④ `generation_id++` 双保险作废在途旧帧。
- **延迟硬靶子**(补 chat-A 自校准的静态上限):TTS flush <60ms、LLM cancel <40ms、端到端 <150ms;false-barge-in <2%。
- **🔑 先 pause 后定夺**(LiveKit,伴侣必备):用户开口先 `audio_output.pause()` 不取消 → `false_interruption_timeout≈2s` 内无真打断则 `resume()` 无缝续播,坐实才 cancel;`backchannel_boundary≈(1.0,3.5)s` 抑制回合首尾"嗯/对啊"误打断。→ AudioTransport 须实现 **pause/resume/clear_buffer/wait_for_playout** 四件套。
- **🔑🔑 被打断写回记忆(OLV `handle_interrupt`,chat-A 最该抄的伴侣细节)**:打断时把"AI 已说出口的半句 + `[被用户打断]`"作为**一条记忆/上下文事件写回**(用 `wait_for_playout` 截断为用户真听到的部分),让人格/情绪能对"被打断"产生反应(委屈/让步/坚持),而非静默丢弃。直服务 §5.3"谁说了什么" + §7 伴侣感。
- **打断敏感度旋钮**(Vocode `interrupt_sensitivity`:low 忽略 backchannel)→ 做成 chat-A 人格刻度(§6 行为即配置:高警觉人格更易被打断)。
- chat-A 已有 InterruptionFrame(SystemFrame,P-1 已实现 system 优先级快道插队 ✓)+ abort 三件套 + §7 URGENT 软反转(用户开口重置 autonomy 预算、丢弃排队独白)——骨架齐备。

## 5. turn-taking / endpointing(已收敛)
- **三层各司其职**:VAD(有没有声)/ TurnDetector·EOU(说完没)/ generation(被插嘴)。
- **动态 endpointing**:`EOU prob < unlikely_threshold`(没说完)→ 把回合结束等待从 `min_delay`(0.3-0.5s)抬到 `max_delay`(2.5-3s);模型超时→固定 delay 优雅降级。**chat-A voice-detect 的 DynamicEndpointing(双 EMA α=0.9)已是此算法 ✓**。
- 演进:MVP 用 STT `is_final`(demo 范式)→ 本地 mini EOU 模型(Smart-Turn v3)。
- **缺口**(自建裸 WS 必补,LiveKit 白嫖 WebRTC):AEC 或"agent 说话时门控 STT"防自打断(树莓派关键,但本阶段 PC 优先);附和/打断分类无开源本地模型,初期启发式(min_words+min_duration+backchannel_boundary)。

## 6. 主动开口(autonomy)并入(已收敛)
- **复用同一回合链**(OLV `ai-speak-signal`):autonomy `SkillScheduler` 决定开口 → **注入一个低优先级"主动 turn"到同一回合调度队列** → 走同一 `Conversation.send → TTS → AudioTransport`,**不另起发声路径**。
- `skip_memory/skip_history` metadata 控制主动话是否入记忆;用户 URGENT turn 抢占主动 turn(§7 已设计)。

## 7. 预测性生成(降延迟,作后续优化,先留接缝)
- interim 就投机跑 LLM(**不授权播放**),回合坐实后**严格快照比对**(transcript+ctx+tools 全等才复用,否则丢弃重生成);护栏 `max_retries=3`/`max_speech_duration=10s`/默认只投机 LLM 不投机 TTS。
- MVP 先留两段式接缝(generate→authorize 解耦,SpeechHandle 停在 `_authorize_event` 未授权);多耗 token,按设备旋钮权衡。

## 8. Provider 工厂位置(已收敛,chat-A 已对)
STT/TTS/LLM/Embedder 在 VoiceLoop **外侧**由工厂按 config 装配,循环内只调接口(OLV ServiceContext / Vocode config 注入 / TEN graph addon)——chat-A 接缝化 + Factory 已是此结构。

## 9. 不照搬清单
- TEN 图编排 runtime(C++/Rust + Agora 绑定,太重)——只借"可插拔接缝"理念(chat-A 已覆盖)。
- Vocode 常驻 worker 流水线 + 黑盒 Agent——只借 `interrupt_sensitivity` + endpointing 思路。
- RealtimeVoiceChat 多线程 + ~10 Event abort——只借"双向握手 + 超时降级"思想,实现走 asyncio 单 task。
- Pipecat 把 turn 判定耦进 LLM 聚合器——chat-A **保持 turn 判定与上下文聚合分离**(模块化原则)。

## 10. 可直接搬运/采用
- voice-core `SentenceSplitter`(句级切分,缩写表+max_chars+fallback)、`echo_prevention_multiplier`(播放时抬 VAD 阈值)、背压丢帧策略。
- OLV `silero.py` VAD 状态机实战默认值:`prob_threshold=0.4`、`required_hits=3`(≈0.1s 触发)、`required_misses=24`(≈0.8s 判停)、pre-buffer 20 帧防丢首音节——作 chat-A voice-detect 起点。
- LiveKit 默认延迟数:`min_delay` 0.3-0.5s / `max_delay` 2.5-3s / `false_interruption_timeout` 2s / `backchannel_boundary` (1.0,3.5)s。

## 11. chat-A 已就位的积木(VoiceLoop 直接组装即可)
AudioTransport+InProcess(P-2)✓ | 帧管线 B层 system 优先级快道+打断广播+10ms 配速(P-1)✓ | voice-detect VAD/EOU+动态 endpointing(P-3)✓ | STT/TTS 接缝+FakeStt/FakeTts+音色复刻(V2)✓ | Conversation.send 完整回合(人格/记忆/closeness/语义召回)✓ | InterruptionFrame 信令(P-1)✓ | §7 优先级队列+URGENT 软反转(设计)✓ | §4.2.1 BusEvents(设计)✓。**缺的就是把它们串成 VoiceLoop + AudioTransport 的 pause/resume/clear_buffer/wait_for_playout。**

## 12. 证据
五份原始报告(task 输出)含 path:line 级证据;关键源:Pipecat `turns/`+`frame_processor.py`、LiveKit `voice/{agent_session,agent_activity,audio_recognition,speech_handle,turn,generation}.py`、voice-core `orchestrator/`、RealtimeVoiceChat `speech_pipeline_manager.py`+`turndetect.py`、realtime-demo `backend/app/main.py`、OLV `conversations/`+`agent/basic_memory_agent.py`+`vad/silero.py`。
