# chat-A 参考源码可复用清单(reference/ 本地源码精读)

> 日期:2026-06-18 | 方法:两轮——先并行 Explore 读片段(正文 §1–§6),再用 general-purpose agent **逐文件完整通读**校正(附录 A–F)。
> **本文已整合为单一真相**:正文中被全文精读推翻的条目均已**就地改正**(标 ✏️);附录 A–F 提供精确数值/公式/file:line 作为权威细节。如仍有冲突,以附录为准。
> 用途:实施阶段按本清单的 `file:line` 直接跳转参考。配合 `reference-projects-research-2026-06-18.md`(外部 GitHub 调研)与设计草案 `superpowers/specs/2026-06-18-embedded-adaptation-design.md` 使用。
> 注意:多数参考用 Redis/Mongo/ChromaDB,**chat-A 是 Node.js + SQLite,只借鉴算法/公式/结构,不照搬这些重依赖**。参考代码本身存在 bug(LingYa 量纲、检索漏乘相似度、Nexus 双衰减体系),移植时**要修不要照抄**(详见附录 C/F)。

---

## 1. 打断 / 取消机制 — voice-core(Python)

路径前缀:`reference/github-projects/voice-core/voice-core-main/`

| 可借鉴 | 位置 | 要点 |
|--------|------|------|
| CancellationToken 类 | `orchestrator/cancellation.py:20-80` | 基于事件的线程安全令牌,`cancel/is_cancelled/reset/wait`。TS 版用 Promise 实现 |
| generation 计数 | `orchestrator/orchestrator.py:66-68,140-150` | ✏️ **仅在 processor 入口检查一次**(`:231-233`),worker 只查 token、不查 processor_id → 真正中断靠 token 级联。chat-A 跨网络须**每帧带 generation 标签**(voice-core 无此能力) |
| 中央打断 | `orchestrator.py:152-166` | cancel token + 清空 audio/sentence 队列 |
| 有界队列反压 | `orchestrator/audio_queue.py:32-90` | `Queue(maxsize)`,`block=True,timeout=5`,满则阻塞 TTS(自然减速) |
| 播放即时停止 | `voice/tts.py:312-334` | ✏️ 回调每帧查 token 抛 `CallbackStop()`,但默认 high-latency block=200ms → **停声延迟 ~200ms**;要快须设 `latency="low"`(50ms) |
| LLM 取消回滚 | `brain/llm.py:176-180` | ✏️ **(原遗漏)** 取消时 pop 刚加的 user message 保历史一致。chat-A 陪伴场景建议反而**保留** user+partial("记得被打断") |
| VAD 状态机 | `ears/stt.py:32-37,440-487` | SILENCE/SPEECH/COMPLETE 三态;✏️ EchoGuard **默认关闭**(`echo_prevention_multiplier=1.0` @ `stt.py:215`,README 误导)→ chat-A 必须真启用 + barge-in 连续 N 帧去抖 |

**关键提醒:**
- voice-core **无任何跨进程/网络取消代码**——chat-A 的"跨网络打断"(设计 §3)必须自研,但其本地模式给出清晰扩展路径。
- agent 建议:用**单一 CancellationToken 级联**比"在多处检查 isCurrent(id)"更不易遗漏路径。chat-A 可两者结合(generation 标签跨网络 + 进程内 token 级联)。

---

## 2. 事件总线 / 流式管线 / Failover / 传输 — Nexus(TypeScript/Electron)

路径前缀:`reference/Nexus-full/Nexus-main/`(及 `reference/Nexus-src/`)

### 2.1 VoiceBus
| 位置 | 要点 |
|------|------|
| `src/features/voice/bus.ts:49-184` | ✏️ **35 事件 + 13 状态机 + emit 返回 effects 交外部执行**、history(maxHistoryLength=50)、`on/onAny/onTransition`、**每 handler try/catch 错误隔离**。chat-A 6 事件是合理裁剪,但须保留:错误隔离 + history 环形 + effects 外部执行 |
| `src/features/voice/busEvents.ts` | 完整事件定义 |

> chat-A 的 6 事件 LightVoiceBus 够用,但建议**补 `stt:partial`、`tts:first_audio`、`provider:failover`** 用于延迟追踪与诊断;history 固定大小模式直接采用。

### 2.2 流式管线(Frame Pipeline,类 pipecat)
| 位置 | 要点 |
|------|------|
| `src/features/voice/tts-pipeline/{Pipeline,FrameProcessor,frames}.ts` | TextDeltaFrame → TextSentenceFrame → AudioFrame 帧流水线 |
| `tts-pipeline/aggregator/SentenceAggregator.ts:18-106` | 按 `/[。！？!?；;\n]/` 聚合成句再 TTS(可提前播放) |
| `src/features/voice/text.ts:23-48` | `prepareTextForTts`:剥离 markdown/URL/舞台指示 `[action]` |
| `tts-pipeline/sinks/AudioPlayerSink.ts:25-92` | **stale turn 防守:丢弃已取消 turn 的迟到音频**(= chat-A generation 丢帧) |

> Nexus **没有** chat-A 的"显示/口语/情绪三分流"——这是 chat-A 特有需求。实现方式:在管线里加一个 `ClassifierProcessor`(提取情绪标签 + 剥离舞台指示),其余沿用帧管线。

### 2.3 Provider Failover(直接可复用)
| 位置 | 要点 |
|------|------|
| `Nexus-src/src_features_chat_failoverChain.ts:49-112` | 候选链构建:同 provider 多 key 自动轮转 + 末尾兜底 Ollama |
| `Nexus-src/src_features_failover_orchestrator.ts:42-86` | 执行器:cooldown 跳过 + 成功/失败记账 |
| `Nexus-src/src_features_failover_runtime.ts:16-110` | **指数退避 `[60s,5m,25m,1h]`**;identity=`providerId\|baseUrl\|model\|key`;错误分类(abort/配置错跳过,网络/429/401 重试) |

> **直接照搬**:退避 4 阶梯与 chat-A 设计一致;identity hash 保证不同配置冷却独立。

### 2.4 ⭐ 音频传输边界(对 AudioTransport 抽象极关键)
Nexus 用 **Electron IPC(不是 WebSocket)**——这正是 chat-A `InProcessTransport`(本地单机/合体)的最佳范本:
| 位置 | 要点 |
|------|------|
| `electron/preload.js:97-149` | **请求-响应(`invoke`)与事件流(`on`)分离**:`ttsStreamStart/PushText/Finish/Abort` + `subscribeTtsStream` |
| `electron/ttsStreamService.js:134-250` | 会话表 `requestId→session`;**首块小(1024 样本)后续大(4096)** 降启动延迟 |
| `src/types/voice.ts:156-214` | PCM 帧结构:`format:'f32le', sampleRate, channels, samples, isFinal` |
| `src/features/voice/streamAudioPlayer.ts:115-188` | `appendPcmChunk` gap-free 调度(AudioContext) |

> **AudioTransport 接口设计直接对标这套 invoke/event 分离 + requestId 会话跟踪。** 本地模式用 IPC/进程内,分离模式换 WebSocket,接口一致。

### 2.5 记忆衰减
| 位置 | 要点 |
|------|------|
| `src/features/memory/decay.ts` | `0.97^days`(半衰期~23天);pinned 不衰;召回 +0.15 上限 1.5;基准取 `lastRecalledAt`(被用即"复活") |

---

## 3. ⭐ WebSocket 客户端-服务端传输 — realtime-voice-agent-demo

路径前缀:`reference/github-projects/realtime-voice-agent-demo/realtime-voice-agent-demo-main/`
**这是 chat-A `WebSocketTransport`(设计 §5.1)的直接范本。**

| 主题 | 位置 | 要点 |
|------|------|------|
| 协议 | `backend/app/main.py:210-324` | **WebSocket 二进制(PCM)+ JSON(控制)混用**;FastAPI handler 模板 |
| 音频约定 | `backend/app/adapters/stt/base.py:19-22` | **硬编码 16kHz / Int16 / mono**(强约定,避免采样率灾难) |
| 前端采集/下采样 | `frontend/app/transcribe-demo.tsx:261-289,548-570` | ScriptProcessor 2048(~46ms);48k→16k 线性插值 |
| 播放 | `transcribe-demo.tsx:524-545` | Int16→Float32,gap-free |
| 轮次检测 | `backend/app/adapters/stt/whisper.py:28-34,62-102` | RMS 能量 + **静音 600ms(`_SILENCE_HANG_MS`)**;min speech 300ms;Deepgram 可走云端原生 VAD |
| 打断(客户端) | `transcribe-demo.tsx:95-112,272-283` | `BARGE_IN_RMS=0.05` 连续 3 帧 → 停本地播放 + 发 `{type:"interrupt"}` |
| 打断(服务端) | `backend/app/main.py:254-267,291-293` | `cancel_response()` 取消 LLM+TTS task → 回 `"interrupted"` 确认;**已生成文本入 history** |
| 会话 SSOT | `backend/app/main.py:155-207` | `_Session` 集中 mode/source/target/tts/history |

**直接采纳到设计:**
- ✅ WebSocket 二进制+JSON 混用;硬编码 16kHz Int16 PCM 约定(解决设计 §8 编解码未决项的一半)。
- ✅ 完整打断三段式:客户端停播 + 服务端 cancel + 确认信令(对齐设计 §3)。
- ✅ 适配器边界严格(`adapters/{stt,llm,tts}/base.py` abstract + AsyncIterator)——印证 chat-A 能力驱动 Provider 抽象。

**必须避免的坑(该项目缺失,chat-A 要补):**
- ⚠️ **无心跳、无自动重连**——chat-A 设计 §4 的心跳/重连退避是正确的补强,务必实现。
- ⚠️ 采样率不匹配 → 杂音;错误路径 WS 资源泄漏(用 try-finally + `asyncio.gather(return_exceptions=True)`);打断不彻底 → 串音;长对话 context 膨胀 → 延迟。
- 注:该项目打断**不带 generation 标签**,靠 cancel + 文本入库。chat-A 的 generation 标签对"取消窗口内迟到帧"更稳健,值得保留。

---

## 4. 人格系统 — LingYa + eros_ai(开源罕见,尤其宝贵)

### 4.1 LingYa(实时 OCC+PAD 情感引擎)
路径前缀:`reference/github-projects/LingYa-src/`
| 位置 | 要点 |
|------|------|
| `mind/config.py:44-112` | **YAML 种子结构**:identity/core_belief/ocean/tone_matrix/behavior_guardrails |
| `mind/state.py:43-56` | OCEAN 初值首次从 YAML,后续从 DB(**种子与演化分离**) |
| `mind/affect.py:327-405` | OCEAN→PAD 基线;`evolve_pad()` spring 回弹 `spring_k=0.2` |
| `mind/affect.py:408-450` | OCEAN drift:每 10 轮,max Δ=0.005(极慢) |
| `mind/tone.py:14-45` | **冷启动**:INITIAL(1-3轮)tone 偏移(克制观察) |
| `mind/tone.py:48-147` | tone = PAD 映射 + OCEAN 非对称调节 + 阶段偏移 |
| `mind/belief.py:10-75` | Belief 更新概率 `0.3+0.4×agreeableness-0.2×conscientiousness` + LLM 双轨 |
| `mind/engine.py:247-280` | **人格注入 prompt**:warmth/formality/humor/mood/stage 动态指令 |

### 4.2 eros_ai(批处理特质演化)
路径前缀:`reference/github-projects/eros_ai-src/`
| 位置 | 要点 |
|------|------|
| `app/models/personality.py:11-75` | ✏️ **32 维** Jungian 特质权重 [0,1],全初始 0.0,永不重置终身累积 |
| `pipelines/personality_update.py:66-95` | **Pass1**:LLM 分析转录 → observed/absent/new_candidates(这是人格唯一的 LLM 调用) |
| `pipelines/personality_update.py:98-162` | **Pass2 是纯 Python 计算,不是 LLM**:`observed×0.3 / absent×−0.15` 非对称 delta,clamp[0,1],版本+1。→ "双 Pass **LLM**" 只适用于记忆调和(§5.3),人格是"1 次 LLM + 1 次算" |
| `pipelines/personality_update.py:165-191` | ✏️ **每次会话结束的事件触发,不是周期/cron**(唯一 cron 是日记@23:59)。chat-A 的"每20轮周期"是合理改良,**别说成借鉴自 eros_ai**;**版本快照 history[]** |

**chat-A 融合建议(印证并优化设计):**
1. LingYa 的 **YAML 种子 + SQLite 演化分离**(chat-A 已采用,验证正确)。
2. **冷启动改进**:前 5 轮 `emotion_intensity×0.5` + 加速 `spring_k=0.5`(比 chat-A 现"前20轮减半"更聚焦)。
3. **混合演化**:即时 OCC→PAD(LingYa 轻量,单次 LLM)+ 每 20 轮二级 OCEAN 信号分析(eros_ai 双 Pass,但 delta 上限 ±0.01,远小于 eros_ai ±0.3)。
4. **版本快照**(eros_ai)记录每次 before/after/delta,便于审计调试。
5. **OCC+IPC 合并一次 LLM 调用**(LingYa `affect.py:263-323`)比双 Pass 更省 token。

---

## 5. 记忆系统 — eros_ai + Nexus + LingYa(chat-A 自研,提炼算法)

### 5.1 ⭐ 零依赖本地向量(最契合 chat-A "P1-P2 不引向量DB")
| 位置 | 要点 |
|------|------|
| `Nexus-full/.../src/features/memory/vectorSearch.ts` | **本地 Hash 256 维嵌入**(FNV-1a 分词 ngram 哈希,归一化),零依赖、冷启快;可选升级 Transformers.js MiniLM |

### 5.2 衰减 + 情感共振 + 混合召回(Nexus)
| 位置 | 要点 |
|------|------|
| `src/features/memory/decay.ts` + `memory.ts` | ✏️ **Nexus 有两套冲突衰减体系**:`decay.ts` 用 `0.97^days`(半衰~23天),`memory.ts` 用 `0.5^(days/30)`(半衰30天),权重表数值还不同 → chat-A **统一用 `0.5^(t/H)`**(H 默认30,语义清晰)。significance 只乘入排序不影响衰减 |
| `src/features/memory/emotionResonance.ts` | **4D→2D Russell VA 投影**;empathy/repair/reinforce 三调节模式;priming 缓冲(最近3条) |
| `src/features/memory/recall.ts:83-140,366-452` | 混合召回:**keyword 30% + vector 70%** + recency/category/decay/emotion 加项;向量门槛 >0.08 |
| `src/features/memory/memory.ts:205-237` | **Jaccard ≥0.72 纯文本去重**(无需向量),重复只更 lastUsedAt;上限 500 |

### 5.3 双 Pass 调和(eros_ai)
| 位置 | 要点 |
|------|------|
| `pipelines/memory_curation.py` | Pass1 提取候选 → Pass2 对标已有 → **diff{add,update,delete,discard}**;daily_context 自动 7 天过期 |
| `app/models/memory.py:17-40` | schema:emotional_weight/entities/access_count/expires_at |

### 5.4 规则快速评分 + 三层衰减(LingYa)
| 位置 | 要点 |
|------|------|
| `memory/store.py:18-31` | **规则毫秒级 importance 评分**(存时不阻塞),异步 LLM 细化 |
| `memory/store.py:257-376` | 三层:Critical>0.8 不衰 / Normal 线性 180天 / Micro<0.3 30天软删 90天硬删;`retrieval_weight` 与 importance 分离。✏️ **存储是 ChromaDB 不是 SQLite**;✏️ **量纲 bug**:衰减阈值用 0.3/0.8 但评分量纲 1-10(几乎全被当 Critical 锁死)→ 移植统一量纲;✏️ `search_weighted` 代码**漏乘 similarity**(与 docstring 不符)→ 移植补上 |

**chat-A 自研记忆推荐配方(全部落 SQLite,已采全文精读校正):**
1. **存储**:单表 + Hot 标记(核心身份 5-10 字段每次注入),不上 Redis/Mongo/ChromaDB。
2. **衰减**:✏️ **统一 `0.5^(days/H)`**(H 默认30天,弃用 Nexus 0.97 双轨),pinned 免衰,召回 +0.15 封顶 1.5;✏️ **惰性 SQL 实时算**(查询时 `importance_score*pow(0.5,(julianday('now')-julianday(ref))/H)`),不批量写回。
3. **情感共振**:Nexus 的 Russell 2D VA(比 4D 简单)+ 三调节模式 + priming(整文件可移植,精确公式见附录 F)。
4. **检索**:keyword 用 **SQLite FTS5**、向量用 **sqlite-vec**(256 维 BLOB)替代 JS 全量点积;混合 `0.3·kw+0.7·vec+recency+category+decay+emotion`(真实权重见附录 F),语义门槛 >0.08。本地 Hash256 仅作离线兜底("伪语义",跨语言弱)。
5. **调和**:eros_ai 双 Pass diff(`add/update/delete/discard`)。✏️ **eros_ai 实为每会话事件触发**;chat-A 用"每 N 轮/会话结束"是合理改良,自定。
6. **评分**:LingYa 规则快速分 + 异步细化,`retrieval_weight` 独立(注意统一量纲)。
7. **人格演化**:✏️ 记忆调和才是"双 Pass LLM";人格演化是"1 次 LLM(信号分析)+ 1 次纯计算 delta"(observed×0.3 / absent×−0.15),见附录 D。

---

## 6. 对设计草案的影响(已回写未决项)

| 设计 §8 未决项 | 本次结论 |
|----------------|----------|
| 音频编解码 | **PCM Int16 16kHz mono 硬约定**起步(realtime-demo 范本);Opus 留待带宽优化 |
| 心跳/重连 | 范本项目缺失 → **印证 §4 必须自研**,退避参数可借 Nexus failover |
| 向量检索(原 P3 才引入) | **可提前**:Nexus 本地 Hash256 零依赖,P1 即可有"伪向量"召回 |
| AudioTransport 接口 | 对标 Nexus IPC 的 **invoke/event 分离 + requestId 会话跟踪** |
| classifier 三分流 | Nexus 无,需自建 `ClassifierProcessor`,挂在帧管线上 |

---

# 附录:全文精读校正(v2,2026-06-18 第二轮)

> 第一轮用 Explore 读片段,本轮用 general-purpose agent **逐文件完整通读**。以下是对上文结论的**重要纠正与补充**,以本附录为准。

## A. voice-core(完整读完 14 文件)
- **generation 计数被夸大**:实际只在 processor 入口检查**一次**(`orchestrator.py:231-233`);TTS/播放 worker **只查 CancellationToken,不查 processor_id**。真正中断靠 token 级联,不是 generation。→ chat-A 跨网络场景必须**每个音频帧带 generation 标签**(voice-core 无此能力)。
- **"即时停止"有 ~200ms 延迟**:默认 high-latency block=200ms(`tts.py:339-340`)。要快打断须设 `latency="low"`(50ms)。
- **EchoGuard 默认是关闭的!**`echo_prevention_multiplier=1.0`(`stt.py:215`),README "自动静音麦克风"误导。→ chat-A 必须真启用回声抑制,且 barge-in 要**连续 N 帧去抖**(voice-core 无去抖,单帧噪声即误触发)。
- **遗漏:LLM 取消即回滚历史**(`llm.py:176-180`)——打断后 pop 掉刚加的 user message,保证历史一致性。chat-A 必须处理(陪伴场景建议反而**保留** user + partial,让 AI "记得被打断")。
- Node 实现**用 `AbortController`/`AbortSignal` 原生替代 CancellationToken**,勿自研;勿照搬其每 turn 起 3 daemon 线程的模型,用 async generator。

## B. realtime-voice-agent-demo(完整读完前后端)
- **协议无 envelope**:音频是裸二进制帧,靠 `typeof data !== 'string'`(客户端)/`bytes vs text`(服务端)分流;**音频段用 JSON `audio/start`…二进制帧…`audio/end` 包裹**作边界。base64-WAV 只在旁路 HTTP `/tts/synthesize`,非 WS 主路。
- **完全没有心跳、没有重连、没有背压**(`audio_q` 无界)、无鉴权/session-id/帧序号。→ **印证 chat-A §4 全要自补**。
- VAD 真实参数:帧 32ms,`SILENCE_RMS=0.012`,`SILENCE_HANG=600ms`,`MIN_SPEECH=300ms`,partials **默认关**(CPU 重转代价)。
- barge-in:`BARGE_IN_RMS=0.05` + **连续 3 帧去抖** → 先本地停播再发信令 → 服务端 LLM+TTS 在**同一个可 cancel task** → partial 入 history。三重触发源(client interrupt / new-turn / config-change)。
- **endpointing 应放服务端**,瘦终端只做 barge-in 轻量触发。
- 坑:`ScriptProcessorNode` 已废弃 → 用 `AudioWorklet`;线性插值重采样精度不足;云 TTS 首帧可能带 44 字节 WAV 头需剥离。

## C. LingYa(完整读完,⚠️ 多处重大纠正)
- **存储是 ChromaDB 不是 SQLite**(`store.py:69-77`)。chat-A 用 SQLite 须自己重写存储/检索(sqlite-vec 或自算余弦)。
- **⚠️ LingYa 根本没有"冷启动情绪减半/加速学习"!** 只有 INITIAL(≤3轮)/DEEP 的 tone 微调(`tone.py:22-45`),不减半情绪、不调学习率。→ **chat-A 的冷启动是自己的设计,不是抄自 LingYa**,需自研。
- **OCEAN drift 极慢**:每 **10 轮**触发,`max_step=0.005`、`min_history=20`,实际单步 ~1e-4(`affect.py:408-450`)。绝非"快速演化"。
- **可直接搬的真实公式**:
  - OCEAN→PAD(Mehrabian):`P=0.21E+0.27A−0.20N+0.14O+0.08C`,归一 `(x−0.25)·2`(D 用 −0.22)(`affect.py:328-365`)
  - PAD 弹簧演化:`new=cur+0.3·pull−k·(cur−baseline)`,k=0.2 交互/0.01 idle(`affect.py:368-405`)——**这就是"指数回归基线"的现成实现**
  - humor 倒 U 型:`0.3+(0.5−|A−0.3|)·0.7`(`tone.py`)
  - importance 规则分:`5+(len>200)+(len>500)+0.5×身份词`(`store.py:18-31`),+ LLM 异步精修(不阻塞主回复)
  - 三级衰减:Critical>0.8 锁定 / Normal `imp·max(0,1−d/180)` / Micro<0.3 30天软删90天硬删(`store.py:257-376`)
  - belief 更新概率:`clamp(0.3+0.4A−0.2C, 0.05, 0.95)`(`belief.py:10-18`)
- **两个 bug 移植时要修**:(1) 衰减阈值用 0.3/0.8 但 importance 量纲是 1-10(几乎全被当 Critical 锁死)→ **统一量纲**;(2) `search_weighted` docstring 说乘 similarity 但**代码没乘**(`store.py:173-236`)→ chat-A 务必把语义相似度真正纳入:`score = sim·exp(−λΔt)·retrieval_weight·emotion_match`。
- **LingYa 无情感共振召回**、belief/guard 护栏**挂着没接线**(主流水线不调用)。

## D. eros_ai(完整读完,⚠️ 重大纠正;且为精选子集,repositories/workers/voice-agent 不在内)
- **⚠️ 触发不是周期/cron,是每次 session 结束的事件触发**(ARQ 任务)。唯一 cron 是 diary @23:59。→ chat-A 的"每 20 轮周期触发"是**合理自研改良,但别说成借鉴自 eros_ai**;建议事件+周期混合。
- **⚠️ 人格 Pass2 是纯 Python 计算,不是 LLM!** 只有 Pass1 是 LLM。所以"双 Pass LLM"**只适用于记忆调和**;人格是"1 次 LLM(信号分析)+ 1 次确定性计算"。
- 人格 delta 真实公式(`personality_update.py:106-127`):`observed: +signal×0.3` / `absent: −absence×0.15`(衰减刻意比增长慢一倍)/ `new: weight≥0.1` 才纳入 / `clamp[0,1]`;单特质单会话最大 +0.15。32 特质 6 分组,全初始 0.0,**永不重置终身累积**,每次演化前快照入 `history`。
- **记忆调和双 Pass(真 LLM×2)可直接移植**(`memory_curation.py`):Pass1 提取(hot/cold + 8 类 subtype + emotional_weight)→ Pass2 调和(`add/update/delete/discard` 四象限,只投喂精简字段省 token)→ apply_diff。**与 chat-A 设计 1:1 对应**。
- hot/cold 是**同一 Mongo 集合靠 `type` 区分**,分层只在 Redis 装载 + prompt 注入策略;chat-A 用 SQLite 单表 + 查询区分即可,**别引 Redis**。
- 过期策略极简:仅 `daily_context` 7 天 TTL。
- `voice/filler.py` 可借鉴:慢操作(检索/推理)前发一句**人格化过渡语**遮蔽延迟。

## E. Nexus 语音/总线/传输(完整读完)
- **VoiceBus 实际 35 事件 + 13 状态机 + emit 返回 effects(总线不执行副作用,交外部 executor)**。chat-A 6 事件是合理裁剪,但**必须保留三条硬约束**:每订阅者 try/catch 隔离、history 环形缓冲、emit 返回 effects 由外部执行(纯函数 reducer)。
- **有两套切分器**:`SentenceAggregator`(标点+3000 上限)与 `streamingTts.ts` 的 `StreamingTtsChunker`(72/24/18 多级阈值 + **首块更早出声** `preferredEarlySplitLength=18`)。要低首句延迟用后者思路。
- **stale-turn 丢弃是 4 层防护**(aggregator turnId / service requestId / sink turnId / pipeline stopped)。chat-A 每层都应带 turn/generation 标识。
- failover 退避真实梯度 `[60s, 5m, 25m, 60min]` 封顶 60 分,**成功立即清零**;**失败计数只对 eligible 错误累加**(用户取消不污染退避)。`buildFailoverKey=domain:providerId:identity`(identity 含 baseUrl+model+key,同 provider 不同 key 独立冷却)。
- **传输关键细节**:首块小 chunk(1024 样本)后续 4096,24kHz;残余奇数字节跨 chunk 拼接;空流主动报 error 让上游快速 failover。
- **`TtsIpcBridge` 接口 = chat-A `AudioTransport` 的现成签名**:`start/pushText/finish/abort + subscribe(返回 unsubscribe)` + requestId 关联。InProcess 直接内存调用,WebSocket 按 requestId 路由,对 pipeline 透明。
- **可几乎零改动移植**:`text.ts`(TTS 文本清理)、`audioPostprocess.js`(PCM↔Float32↔WAV + 淡入淡出/归一化/去 DC)、`frames.ts` + `FrameProcessor.ts` + `Pipeline.ts`(帧管线骨架)、`failover/orchestrator.ts`(泛型执行器)。
## F. Nexus 记忆/情感(完整读完,精确数值)
- **Nexus 实际是 3 层**(long_term 上限 500 / daily 每天 16 条 / cold archive 衰减分<0.15 归档),**不是 chat-A 的 4 层 Hot/Short/Long/Cold**——chat-A 的 4 层是自有设计。存储是 localStorage(前端)。
- **⚠️ Nexus 没有"双 Pass 调和"**(全仓零命中)。chat-A 的双 Pass 是自有设计,**记忆调和的可移植实现要看 eros_ai**(附录 D),不是 Nexus。
- **⚠️ Nexus 有两套冲突的衰减体系,移植前必须统一**:
  - 体系 A `decay.ts`:`score=base·0.97^days`,半衰期 ~23 天;importance seed pinned1.0/high0.8/reflection0.6/normal0.5/low0.25;召回 +0.15 封顶 1.5;ranking `= decayed·(1+significance·0.4)`。
  - 体系 B `memory.ts`:`0.5^(ageDays/30)`,半衰期 30 天;权重表数值还不一样(high0.85/low0.2)。
  - → chat-A **统一用体系 B 的 `0.5^(t/H)`**(语义清晰,H 可配默认 30)。
- **情感共振(`emotionResonance.ts`,精确)**:`MAX_EMOTION_BOOST=0.15`;VA 投影 `valence=warmth−concern`、`arousal=(energy+curiosity)/2`;三模式 directional:reinforce `0.7·resonance+0.3·salience` / empathy `resonance·salience` / repair `(1−resonance)·max(memVA.valence,0)`;门控 `gate=intensity, <0.05 则不偏置`;priming 缓冲容量 3 `0.15·(1−dist(memVA,centroid))`。
  - significance(`decay.ts`):`0.35·valenceExtremity+0.45·arousalBoost+0.2·concernSignal`。
- **混合召回 finalScore(`recall.ts`,真实权重)**:hybrid = `0.3·keyword + 0.7·vector + recency + category + decayBoost + emotion`。
  - recency `max(0,1−min(ageH,96)/96)·0.18`;category feedback.15/project.10/manual.08/preference.05/goal.05/reference.03/habit.02/profile0;decayBoost `(decayed−0.5)·0.3·(1+sig·0.4)`(**以 0.5 为中心,低于 seed 得负 boost**);emotion ∈[0,0.15];语义展示门槛 `>0.08`。
- **本地 Hash 嵌入(`vectorSearch.ts`)**:FNV-1a 32bit + 词 token + **compact 串 2-gram/3-gram(中文友好,无需分词)** + 256 维 + L2 归一;cosine 因已归一只做点积。**注意:这是"伪语义"**(字符 n-gram 哈希),跨语言/同义词召回弱 → 追求质量默认走远程 MiniLM(`Xenova/paraphrase-multilingual-MiniLM-L12-v2`),Hash 仅离线兜底。
- **去重**:长期 Jaccard 0.72 / containment 0.85(minWords≥3);daily 0.88 且同 role;命中只刷 lastUsedAt。
- **SQLite 化优化(关键)**:keyword 用 **FTS5 `MATCH`** 替代手算 Jaccard/BM25;向量用 **`sqlite-vec`** 存 256 维 BLOB,替代 JS 全量 O(N) 点积;**衰减惰性计算**——查询时 SQL 实时算 `importance_score*pow(0.5,(julianday('now')−julianday(ref))/H)`,不批量写回;冷归档定时 `DELETE WHERE decayed<0.15`。
- chat-A 的"双 Pass 调和"可这样落:Pass1 用 finalScore 粗排 Top-K,Pass2 在 Top-K 内做去冗余/时间多样性/情感连贯重排(复用 priming centroid 让选中项情感质心连续)。

> 核心文件:`src/features/memory/{decay,emotionResonance,recall,vectorSearch,vectorSearchRuntime,memory,memoryPersistence,coldArchive,constants}.ts`、`src/types/memory.ts`、`src/features/autonomy/emotionModel.ts`。

---

## G. 自主行为 / 自我 / 情绪驱动(为"伴侣而非助手"重读,2026-06-19)

> 视角:Agent 要有自己的性格/情绪/思想、会主动、会不服从、有自己的记忆和故事。

### G.1 Nexus 自主行为(可直接借鉴的"克制主动"骨架)
- **三层分离**(`src/features/autonomy/README.md:44-56`):纯引擎(无 React/IPC)/ controller(接线)/ hooks。chat-A `autonomy/` 直接照此分层。
- **决策管线**:`tick → gather context → decision LLM(JSON: silent|speak|idle_motion) → persona guardrail → speak`(`v2/{orchestrator,decisionEngine,decisionPrompt}.ts`)。**用 LLM 决策替代规则树,绝大多数 tick 返回 silent**。
- **三道节流闸**:每日 tick 上限(`tickLoop.ts:77-87`)+ 动态 cadence(相位×情绪×idle×关系,`providerResolution.ts:125-162`)+ inflight 锁。
- **情绪→主动倾向** `resolveProactiveLean`(`emotionModel.ts:500-517`):concern 高→轻声关心、energy 低→安静、明亮+好奇→俏皮分享;**restraint-first,只在边界微调,绝不覆盖上游抑制**。
- **idle 情绪弧 once-per-episode**(`emotionModel.ts:204-233`):10min 蔫→4h 想念→重逢暖跳,**每段空闲每阶段只触发一次**(做"想念/重逢"必抄此模式)。
- **跨会话内在连续三件套(最值钱)**:当前情绪持久化 + `stateTimeline.ts`(变化≥6%/6h 采样,留 365 天)+ `affectGuidance.ts`(把过去 14 天情绪走向注入**每轮 prompt**)。
- **夜间沉淀 dream**(`hooks/useMemoryDream.ts` + `memoryDream.ts`):睡着时把 daily 压成长期记忆 + 反思 + 叙事线 + callback,**摊销到本就要跑的 LLM 上**。
- **叙事产物**:周日信(`features/letter/`)、callback 回忆杀(`reflectionGenerator.ts:205-287`)、里程碑措辞极克制(`milestones.ts:38-62`,反"假惺惺"哲学)。

### G.2 LingYa 情绪驱动 + 自我一致(可整体借鉴)
- **OCC→PAD→IPC→tone→prompt fragment 整条流水线**(`affect.py`/`dynamics.py`/`tone.py`/`engine.py:247-280`):情绪是真实状态变量,心情差→语气真的会沉(`engine.py:259-262`);tone 能输出**冷淡**腔(warmth≤20,`engine.py:322-351`)。
- **guard re-anchor**(`guard.py:9-56` + `engine.py:282-299`):回复与 identity kernel 余弦相似度 <0.3 判漂移→重锚。**"不被用户带跑"直接抄**(但阈值要放宽以允许有个性的偏离)。
- identity/core_belief 静态注入(`engine.py:51-58`)+ OCEAN 种子→DB→drift(`affect.py:408-450`)= 稳定但可缓慢演化的自我。

### G.3 ⚠️ 三个参考项目都没有、chat-A 必须自创的(差异化核心)
1. **"会反对/不服从"**:LingYa belief/guard 只"对内防漂移",**无任何"对外顶撞"机制**;belief.py 还是**未接线的孤儿模块**;STATIC_PROMPT 写死"服从人类"。→ chat-A 自创:**stance/分歧检测**(用户观点 vs `core_belief`/`self_notions` 冲突→生成异议而非顺从),改写"服从"默认。
2. **`self_notions`(自我观念清单)做实**:LingYa 定义了(`state.py:38`)但全代码无读写。→ chat-A 把它做成"我相信X/讨厌Y/对Z有看法",作为反对用户的依据。
3. **负面/不合作姿态**:IPC 5 态全是亲社会(连防御都是"professional"),**没有赌气/冷淡/withdrawn**;error stage 还走"回归倾听"。→ chat-A 新增 SULKING/WITHDRAWN 态,允许"我现在不想说话"。
4. **Agent 自己的内在生活**:Nexus 情绪/记忆/叙事全**面向用户**,Agent 没有"自己的一天、内生情绪/好奇、自传式记忆、会演化的性格"。→ chat-A 自创**内生事件源/兴趣调度 + Agent 第一人称记忆(dream 自动写入 `subject=agent`)+ 叙事反哺人格**。
5. **eros_ai 是反面教材**:它把"人格"建模在**用户**身上以便讨好——正是 chat-A 要拒绝的助手范式。仅 `voice/filler.py` 的"persona modifier 注入语气"可借。
