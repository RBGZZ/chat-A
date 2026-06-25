# 流式优先 / 快反应 / 低音频延迟 调研发现（2026-06-25）

> 只读调研产出（UTF-8 中文）。背景痛点 **R7**：chat-A desktop 文字流式很快，但**音频朗读慢几秒**——根因三连击：①等整段回复才开始合成 ②bilingual 翻译通道**第二次 LLM 调用**串在 TTS 前 ③复刻音色为防漂移改成「整段一次合成」。
> 用户确立的设计原则：**流式优先、系统快速反应优先——不必完美回答，但反应一定要快，音频回复尽可能零延迟。**
> 证据分两类：**[已验证]**=本地 `reference/` 有 file:line 或本仓 docs/源码可查；**[推断/待确认]**=由约定/惯例推导。参考根 `reference/github-projects/`（下称 `…/`）。
> 本文**在既有调研之上提炼**，不重复造：底层做法见 `voice-pipeline-findings-2026-06-23.md`、`voice-loop-findings-2026-06-23.md`、`voice-infra-findings-2026-06-22.md`；R7 现状/教训见 `voice-module-issues-2026-06-25.md` §E2/§D。

---

## 0. 一句话结论

**首音延迟的命门 = 把"等整段 → 整段合成"换成"边生成边按句切 → 第一句立刻喂流式 TTS"，并用"先应一声"掩盖剩余延迟。** chat-A 现已有句级切分（voice-loop `SentenceSplitter`）与流式 TTS（qwen/CosyVoice run-task），但 **desktop 朗读路（R7）为防复刻音色漂移退回了整段一次合成**——这是延迟主因。解法不是放弃逐句，而是**复刻音色下用「单 task 多次 continue-task 增量喂文本」**保持单一合成会话（音色不漂移）+ **去掉/旁路 bilingual 第二次 LLM 串行调用**。

---

## 1. 降首音延迟的具体技术清单（成熟项目怎么做的，按性价比排序）

> 性价比 = 延迟收益 ÷ 实现成本（对 chat-A 现栈）。★=高性价比应优先。

### ★① 按句切分 → 第一句立刻喂 TTS（SentenceDivider/SentenceSplitter）
LLM token 流不等整段，按句边界切，**第一句一成形就送 TTS**，后续句边生成边合成。这是所有成熟项目的共识起手式。
- **Open-LLM-VTuber**：`SentenceDivider(faster_first_response=True)` —— **首句按逗号切**（更早触发首音），后续按 pysbd 句切分；带缩写表防误切。`…/neuro-ecosystem/Open-LLM-VTuber/src/open_llm_vtuber/utils/sentence_divider.py:301-323`（`faster_first_response` 注释 "split first sentence at commas"），缩写表 `:31-46`。[已验证]
- **voice-core**：`SentenceSplitter(min_tokens=5, max_chars=200)`，缩写集合 + `max_chars` 强制边界切分（防 TTS 模型音素溢出，Kokoro-onnx 510 音素上限）。`…/voice-core/voice-core-main/orchestrator/streaming_utils.py:21-78`。[已验证]
- **LiveKit**：`split_sentences(min_sentence_len=20)` + 缩写表。`…/voice-infra/agents/livekit-agents/livekit/agents/tokenize/_basic_sent.py:1-79`。[已验证]
- **chat-A 现状**：voice-loop 已采用此模式（`voice-loop-findings` §1/§10「可直接搬 voice-core SentenceSplitter」）；**但 desktop 朗读路 `splitReplySentences` 退回 `[text]` 整段**（`packages/desktop/src/main.ts:417-419`，注释钉死原因=复刻漂移）。[已验证]

### ★② 流式 TTS 协议：边送文本边出音频
TTS 不是"喂完整句再等整段 wav"，而是**文本进、音频块（PCM chunk）持续出**，首块到达即播。
- **RealtimeVoiceChat**：`synthesize()` 流式产音频块入队，`QUICK_ANSWER_STREAM_CHUNK_SIZE=8` / `FINAL_ANSWER_STREAM_CHUNK_SIZE=30`（小块压首音、大块保吞吐）。`…/neuro-ecosystem/RealtimeVoiceChat/code/audio_module.py:27-29`；worker `…/code/speech_pipeline_manager.py:534-641`。[已验证]
- **chat-A 现状**：qwen-tts-realtime / CosyVoice run-task **本就是流式协议**（边送文本边出 PCM 裸帧）——`voice-module-issues` §E2 明确「qwen-tts-realtime 本就流式，整段也边合边出音」。即整段合成≠非流式，但**首音仍要等整段文本生成完才发第一次 append**。[已验证]

### ★③ "先应一声 / 语气词"掩盖延迟（backchannel / filler）
在真正答案的 TTS 还没出来前，**先播一个短促语气词/承接句**（"嗯…""让我想想""这个啊"），把感知首音延迟压到接近零——人类对话本就如此。
- **LiveKit**：`_FillerScheduler`，`_delay`（开口前等待）+ `_interval`（语气词间隔）+ `_source`（固定串或动态可调函数），监听 speaking 事件在 idle 期喷出 filler。`…/voice-infra/agents/livekit-agents/livekit/agents/voice/filler_scheduler.py:15-116`；测试 `…/agents/tests/test_filler.py`。[已验证]
- **RealtimeVoiceChat**：用 quick/final 两段（见④）达到类似效果——quick 段是"先出的短答"。[已验证]
- **chat-A 现状**：**无**。这是 R7 最高性价比的"零成本"掩盖手段——即便不改合成架构，先播一个本地预合成/缓存的语气词音频，体感立刻"秒应"。[待落地]

### ★④ 两段式 quick/final TTS（先出短答，再补全文）
把回复切成**"快答"(quick)**和**"全文"(final)**两段：LLM 首个自然句边界处截断作 quick 立即合成播放，剩余 token 作 final 在 quick 播放期间并行合成续上。
- **RealtimeVoiceChat**：`RunningGeneration` 维护 `quick_answer`/`quick_answer_overhang`/`final_answer` 等状态（`…/code/speech_pipeline_manager.py:66-111`）；`_llm_inference_worker` 在首个自然句边界截 quick（`:395-404`，未找到边界则整段作 quick `:413-419`）；`_tts_quick_inference_worker`（`:534-641`）与 `_tts_final_inference_worker`（`:643-768`）**两 worker 并行**，输出同一音频队列；`get_generator()` 先 yield quick 的 overhang 再 yield 剩余（`:687-725`）。**关键：quick 与 final 用同一 voice / 同一 engine**，overhang 概念保证半词不断裂。[已验证]

### ⑤ 并行化：生成与合成 overlap（段级并发 TTS）
LLM 流遇句/段边界即切，**下一段合成在上一段播放期间就启动**（不串行等播完）。
- **LiveKit**：`agent_activity.py:2742-2760`，`FlushSentinel` 切段，下段 TTS 提前启动（单飞 `await prev_tts_task` 但提前 schedule）。`voice-infra-findings` §3。[已验证]
- **Open-LLM-VTuber**：`TTSTaskManager` 用**序列号**维护乱序合成、顺序交付（并发合成但播放顺序一致）。`…/Open-LLM-VTuber/src/open_llm_vtuber/conversations/tts_manager.py`（`_process_payload_queue` 缓冲乱序按序发）。[已验证]
- **chat-A 现状**：canonical §4「乱序生成/顺序播放(seq 重排)、TTS chunker 前 N 句 boost」已纳入设计；帧管线 B 层有 generation 标签 + seq。[已验证设计]

### ⑥ 预热 / eager 连接（prewarm / warmup）
启动期/空闲期**预热模型连接与首帧路径**，避免首回合冷启延迟。
- **RealtimeVoiceChat**：`self.llm.prewarm()` + `measure_inference_time()`（`…/code/speech_pipeline_manager.py:170-171`）；TTS 引擎 `__init__` 预加载模型 + `measure_inference_time()` 量首帧延迟（`…/code/audio_module.py:88-121`）。[已验证]
- **chat-A 现状**：canonical §5.7 已埋 `prewarmRecall(partialText)`（记忆侧）接缝；**TTS/LLM WS 连接预热未见**——qwen/CosyVoice 是 WS provider，**首次建 WS + session.update 握手有固定开销**，可在 app 启动/空闲时预建连。[待落地]

### ⑦ 预测性生成（preemptive generation，吃掉 LLM 首字延迟）
STT interim 一变就**先跑 LLM 不出声**、缓存快照；轮次坐实后比对输入指纹命中即复用。属"另一半延迟红利"。
- **LiveKit**：`agent_activity.py:2022,2061,2248-2268`；护栏 `max_retries=3`/`max_speech_duration=10s`/默认不投机 TTS。`voice-infra-findings` §3。[已验证]
- **chat-A 现状**：canonical §4/§5.7 已纳入设计接缝（`prewarmRecall` 同源）；**语音输入路才用得上，朗读路(R7)用不上**（R7 是文本已生成后的合成延迟，非 LLM 首字延迟）。[已验证设计]

### ⑧ EOU 概率驱动动态 endpointing（少等、不抢话）
非首音延迟，但属"快反应"——`EOU prob<阈值`(没说完)把静音窗 `min_delay(0.3-0.5s)→max_delay(2.5-3s)`，两个 EMA(α=0.9)学句内/轮间停顿。
- **LiveKit** `DynamicEndpointing`（`endpointing.py:49-74`）；chat-A voice-detect 已实现此算法（`voice-loop-findings` §5）。[已验证]

---

## 2. "快反应优于完美"的具体落地手法（参考项目实证）

| 手法 | 实现 | 出处 | 本质 |
|---|---|---|---|
| **先出短答再补全文** | quick/final 两 worker 并行，首个句边界截 quick 立即播 | RealtimeVoiceChat `speech_pipeline_manager.py:66-111,395-404,687-725` | 不等完整答案，先把"开头"送出 |
| **先喷语气词** | `_FillerScheduler` 在 agent 开口前/idle 喷 filler | LiveKit `filler_scheduler.py:15-116` | 用"嗯…"占位，掩盖思考/合成延迟 |
| **首句按逗号切** | `faster_first_response` 首句逗号即切（不等句号） | OLV `sentence_divider.py:304,312` | 第一段更短=更早出声 |
| **流式部分回答可被打断** | 一个 AbortSignal 串 LLM/TTS/播放；半句写回上下文(标 interrupted) | LiveKit/Pipecat/OLV `handle_interrupt`；canonical §4 | "话说一半被打断"是伴侣特征，非 bug |
| **不等完整句也先出** | 句边界 + `max_chars` 强制切，长句不憋死 | voice-core `streaming_utils.py:200-235` | 宁可早出、不憋整段 |
| **优雅降级=快反应一种** | TTS 失败只显示文本不哑、语义召回超时退快路径 | canonical §3.2/§5.7 | "反应到位"不等于"音频到位" |

**核心范式**：成熟项目都把"完整正确的长答"让位给"立刻出声的短答 + 流式续上"。chat-A 北极星=伴侣而非助手，这条**天然契合**——真人对话本就先"嗯/对/这个啊"再展开。

---

## 3. CosyVoice / 我们栈的契合点：逐句流式 vs 音色一致

### 3.1 问题本质（R7 的两难）
- chat-A desktop 朗读**曾**逐句合成（`splitReplySentences` 用 SentenceSplitter），**复刻音色每句独立 WS 合成 → 逐句音色漂移**，听感"多音色混杂"（`voice-module-issues` §E2，commit `4897b23`）。
- 为消漂移**退回整段一次合成**——音色一致了，但**首音=等整段文本生成完**，慢几秒。

### 3.2 参考项目怎么平衡"逐句流式"与"音色/韵律一致"
关键洞察：成熟项目**不是靠"整段一次合成"求一致，而是靠"单一合成会话内增量喂文本"**——
- **RealtimeVoiceChat**：quick 与 final **同一 voice/同一 engine**，`quick_answer_overhang` 保证半词不断裂（`speech_pipeline_manager.py:90-93,687-700`）；不是"每句新建会话"。[已验证]
- **voice-core**：`_synthesize_chunked` 在词/句边界切分但**逐块拼接、维持单一 voice context**（`…/voice/tts.py:152-218`）。[已验证]
- **Open-LLM-VTuber**：并发合成 + 序列号顺序交付（`tts_manager.py`），但底层 TTS（CosyVoice/GPT-SoVITS）多为**整句/整段一次推理**——OLV 的一致性靠"同 voice + 顺序播"，不靠"一次喂整段"。[已验证]

### 3.3 chat-A 的正解：单 task 多次 continue-task 增量喂文本
**已知（memory + `voice-module-issues` §B4）**：CosyVoice run-task 协议 = **run-task(开 task) → 多次 continue-task(增量喂文本) → finish-task**，全程**同一 task_id / 同一合成会话 / 同一音色上下文**，音频是持续二进制裸帧流。qwen-tts-realtime 同理：单 WS session 内多次 `input_text_buffer.append` 增量喂，单次 `commit`。
- **这正是"逐句流式"与"音色不漂移"的交集**：在**同一个 task/session 内**按句 append（边生成边喂），首句一成形就 append → 首音早出；因是同一会话，**音色/韵律一致、不漂移**。
- **与 R7 退回整段的区别**：整段=等全文生成完才发**一次** append；正解=**全文边生成边发多次** append，**仍是同一 task**。音色一致性来自"同一 task"，**不来自"一次 append"**——R7 当初把两者绑死了，是过度收缩。[推断，**强烈建议真机验证**：在同一 qwen-tts-realtime session 内分多次 append 增量喂，确认复刻音色不漂移]
- **护栏**：append 切分粒度别太碎（voice-core `min_tokens=5`/`max_chars` 思路），太碎可能引入韵律顿挫；CosyVoice 复刻对**语速敏感**（`voice-module-issues` §B7，`CHAT_A_TTS_RATE=0.8`），增量喂时 rate 与 instruction 别打架。

### 3.4 bilingual 翻译通道的串行 LLM 调用（R7 第二根因，独立于音色）
- **现状**：朗读路若显示语种≠合成语种，`translateForSpeech` **用 `handle.llm` 再发一次 system+user 流式补全**（`packages/desktop/src/main.ts:452-457,475-489` `completeOnce`），**串在 TTS 之前**——整段译完才开始合成，叠加一次完整 LLM 往返延迟。[已验证]
- **参考项目做法**：realtime-demo / OLV 的"translate 模式"是在**主回合 prompt 内**让 LLM 直接以目标语种生成（`system_prompt_for(mode,source,target)`，canonical §4.1 已引），**不是事后再翻一遍**——一次生成、零额外往返。[已验证设计]
- **正解**：**把"用目标语种生成"并进主回合 prompt（让 LLM 一次就产出合成语种文本）**，消除第二次 LLM 调用；只有"显示语种与合成语种必须不同字面"且无法共用时才退回事后翻译。退路时也应**逐句翻译+逐句喂同一 task**，而非整段翻完再合成。[建议]

---

## 4. 首音延迟预算 / 数字（参考项目 + 既有文档）

> chat-A 当前**未对"音频首音(TTFA)"定硬数字**；canonical §3.2 只说"每阶段定延迟预算(首 token/首音频)"原则，未填值。下列为参考锚点。

- **RealtimeVoiceChat**：显式测 **TTFT**（LLM 首 token，`speech_pipeline_manager.py:390-391`，精确 0.0001s）+ **TTFA**（首音频块，`audio_module.py` debug log）；端到端预算 `full_output_pipeline_latency = llm_inference_time + tts_inference_time`（`:214-216`）。[已验证]
- **LiveKit**：per-message MetricsReport 指标字典含 `ttft/ttfb/transcription_delay/end_of_turn_delay/playback_latency/e2e_latency`（`voice-infra-findings` §3）；打断延迟硬靶 TTS flush <60ms、LLM cancel <40ms、端到端 <150ms、false-barge-in <2%（`voice-loop-findings` §4）。[已验证]
- **endpointing 数字**：`min_delay` 0.3-0.5s / `max_delay` 2.5-3s / `false_interruption_timeout` 2s（`voice-loop-findings` §10）。[已验证]
- **业界经验值（口语对话"像人"门槛）**：端到端首音 **<800ms~1s** 体感自然，>2s 明显"卡"；filler 可把感知首音压到 **~200-400ms**。[推断/经验值，**待确认**——参考项目未给统一硬阈值，多为自校准]
- **chat-A 建议靶子（待真机校准）**：朗读路首音 **TTFA p50 < 800ms / p95 < 1.5s**；接 filler 后感知首音 < 400ms。canonical §3.2 应把"首音(TTFA)"列为**自校准延迟预算**的显式一档（实测 → trace §8.1）。[建议]

---

## 5. 可直接写进 canonical §3.2/§4 的设计原则陈述

> 拟入 canonical §3.2 核心原则（升为与"延迟预算"并列/其下的子原则），并在 §4 落地为子条款。

### 原则（陈述句）

> **【流式优先 · 快反应优先 · 音频低延迟】**
> chat-A 是实时语音**伴侣**，"反应快"优先于"答得全"。系统宁可**先出一个不完整但即时的回应**，再流式补全，也绝不让用户等一个完美的整段。**流式贯穿全链**（LLM token → 句切 → TTS → 播放），任一环节都不得"攒齐整段再处理"。新增功能若延长首音延迟，必须论证并给降级路径。

### 可操作子条款（落 §4 / B-C 层）

1. **首句即合成**：LLM token 流按句边界（首句可按逗号，`faster_first_response`）切分，**第一句一成形立即喂流式 TTS**，绝不等整段。后续句边生成边合成、段级并发。
2. **绝不等整段**：朗读/语音回复路一律**增量喂文本**；复刻音色场景用**单 task/session 多次 continue-task/append**（同一合成会话）兼顾"逐句流式"与"音色不漂移"——音色一致来自"同一 task"，不来自"一次喂整段"。
3. **先应后补（掩盖延迟）**：真正答案的首音未到前，**先播一个短语气词/承接音**（filler，可本地预合成/缓存）占位；伴侣人格下"嗯…/让我想想"本就自然。
4. **可打断、半句可回**：一个 AbortSignal 串起 LLM/TTS/播放，用户开口可随时打断流式回复；被打断的半句写回上下文（标 `interrupted`），人格可对"被打断"产生反应。
5. **生成即目标语种，不事后翻译**：bilingual 合成语种由**主回合 prompt 一次生成**目标语种文本（不串第二次 LLM 翻译）；万不得已退回事后翻译时也须**逐句翻译 + 逐句喂同一 task**，绝不"整段翻完再整段合成"。
6. **首音延迟进预算与 trace**：把音频首音(TTFA)列为**自校准延迟预算**显式一档（实测 TTFT/TTFA → 阈值 → §8.1 trace）；超预算告警、可降级（如跳 filler 之外的增强）。
7. **预热消冷启**：app 启动/空闲期预建 TTS/LLM 流式连接(WS session)与首帧路径，首回合不吃冷启延迟。

---

## 6. 映射 chat-A：现状缺什么、该采纳什么（尤其 bilingual / 朗读路）

| 技术 | chat-A 现状 | 缺口/动作 | 性价比 |
|---|---|---|---|
| 句级切分喂 TTS | voice-loop 有；**desktop 朗读路退回整段** | **朗读路恢复逐句增量喂**（见下"单 task append"） | ★高 |
| 单 task/session 增量喂文本(防漂移) | CosyVoice run-task / qwen append **协议本就支持**，但朗读路只发一次 | **同一 task 内分多次 append/continue-task 喂逐句**，真机验证复刻音色不漂移 | ★高（直击 R7） |
| bilingual 第二次 LLM 串行翻译 | `translateForSpeech`+`completeOnce` 串在 TTS 前 | **改为主回合 prompt 直接生成目标语种**；消除第二次往返 | ★高（直击 R7） |
| 先应一声 filler | **无** | 预合成/缓存若干语气词，首音未到先播；zero-cost 掩盖 | ★高 |
| 流式 TTS 协议 | **已有**(qwen/CosyVoice 流式) | 维持；确保 append 后首块即播不缓冲 | — |
| 段级并发合成/seq 重排 | 设计已纳入(canonical §4) | 朗读路落地（多句时下句提前 schedule） | 中 |
| 预热/eager 连接 | 记忆侧有 `prewarmRecall`；**TTS/LLM 连接预热无** | 启动/空闲预建 WS session | 中 |
| 预测性生成 | 设计已纳入 | 语音输入路用；朗读路 N/A | 中（非 R7） |
| 动态 endpointing | **已实现**(voice-detect 双 EMA) | 维持 | — |
| TTFA 延迟预算/数字 | **未定硬数字** | canonical §3.2 加"首音(TTFA)自校准档" + trace 指标 | 中 |

### R7 直接处方（按落地顺序）
1. **去 bilingual 串行翻译**：让主回合按 `output_lang` 生成合成语种文本（canonical §4.1 已有 prompt 注入目标语种的设计），删除朗读路 `translateForSpeech` 的第二次 LLM 调用。→ 砍掉一整次 LLM 往返。
2. **朗读路恢复逐句、但在同一 task/session 内增量喂**：`splitReplySentences` 重新逐句，`makeSynthesize`/`runSpeakReply` 改为**对同一 qwen-tts-realtime session（或 CosyVoice run-task）连续 append 逐句**，而非每句新建 WS 连接。→ 消除"等整段"，且因同一会话**不漂移**（**待真机验证此假设**）。
3. **加 filler 先应**：首块 PCM 到达前先播一段缓存语气词。→ 感知首音趋零。

---

## 7. 拿不准 / 待确认

- **[待确认·关键]** "同一 qwen-tts-realtime session 内多次 append 逐句喂"是否**真的不漂移**（R7 当初的漂移是"每句独立 WS 合成调用"=多 session 造成；同一 session 多次 append 理论上不漂移，但**未在真机验证**）。这是 R7 处方 #2 的成立前提，应优先真机测。
- **[待确认]** CosyVoice continue-task 逐句增量喂时，**复刻音色 + 语速(rate 0.8) + instruction** 三者在分块边界是否产生韵律顿挫（`voice-module-issues` §B7 已知 rate 敏感）。
- **[待确认]** 首音延迟硬数字（<800ms 等）为业界经验值，参考项目多用自校准而非固定阈值；chat-A 实际靶子需 PC/真机 benchmark 后定。
- **[待确认]** filler 在伴侣语境的"度"——喷太勤显得敷衍；LiveKit `_delay`/`_interval` 可调，需按人格(§6 行为即配置)调参。
- **[推断]** RealtimeVoiceChat 行号据子代理 Explore 汇报与抽样直读交叉，未逐行复核全部；quick/final 两段架构、chunk size 8/30、prewarm 已直读确认（`audio_module.py:27-29`、`sentence_divider.py:301-323`）。

---

## 主要证据文件
- 参考源码：OLV `…/neuro-ecosystem/Open-LLM-VTuber/src/open_llm_vtuber/utils/sentence_divider.py:301-323,31-46`、`…/conversations/tts_manager.py`；RealtimeVoiceChat `…/neuro-ecosystem/RealtimeVoiceChat/code/{speech_pipeline_manager.py:66-111,330-440,534-768,687-725,164-172,214-216,390-391, audio_module.py:27-29,88-121}`；voice-core `…/voice-core/voice-core-main/orchestrator/streaming_utils.py:21-78,200-235`、`…/voice/tts.py:152-218`；LiveKit `…/voice-infra/agents/livekit-agents/livekit/agents/{voice/filler_scheduler.py:15-116, voice/endpointing.py:49-74, tokenize/_basic_sent.py:1-79}`；Pipecat `…/voice-infra/pipecat/…`（帧管线，见 voice-infra-findings）。
- 本仓 docs：`voice-pipeline-findings-2026-06-23.md`、`voice-loop-findings-2026-06-23.md`、`voice-infra-findings-2026-06-22.md`、`voice-module-issues-2026-06-25.md`（§E2/§D/§B4/§B7）、`chat-a-canonical-design.md`（§3.2/§4/§4.1）。
- 本仓源码：`packages/desktop/src/main.ts:380-489`（makeSynthesize/splitReplySentences/speakReply/completeOnce）、`packages/runtime/src/voice-loop.ts`、`packages/providers/src/{qwen-tts-realtime,cosyvoice-tts,cosyvoice-voice-clone}.ts`。
