# 参考项目的部署与轻量化策略 → chat-A 的 PC 优先 + 嵌入式轻量化适配（2026-06-23）

> 来源：对本地 `reference/` 参考项目源码的多代理精读（9 代理 / 8 项目簇：Neuro SDK+core、Open-LLM-VTuber、实时语音管线[voice-core/realtime-demo/Pipecat/LiveKit]、Zerolan 生态、AIRI+projectBEA、Nexus、LingYa+eros_ai、memory-frameworks[mem0/Letta/OpenMemory/memoripy]）。视角：**PC 优先开发、为嵌入式（树莓派/手机）做轻量化适配**。结论区分「已验证（有路径证据）」与「推断」。

## 1. 一句话结论

**整体格局（已验证）：8 个项目簇无一例外都是「PC/服务端优先」，没有一个有真正的树莓派原生推理路径**——Neuro/AIRI/projectBEA 明确假设 24GB+ RAM / 8–12GB VRAM，Zerolan 最小专属也要 ~7GB，云端栈更重。

**最强支撑**：chat-A 的「PC 优先」是被参考项目集体验证的正确起点；真正可复用的不是它们的部署形态，而是其中两个项目内建的「**零代码切换 + 优雅降级**」接缝——**Open-LLM-VTuber**（Factory + YAML + 能力哨兵）和 **Nexus**（failover orchestrator + local-hash 默认 + idle 状态机）是唯二把「轻量化后路」做进架构的样本。memory-frameworks 验证了「SQLite + 本地嵌入 + ADD-only 热路径」在嵌入式可行。

**最强警示（部分证据 + 推断）**：嵌入式的真正杀手不是 LLM（可量化/可回源），而是 **TTS**——CoquiTTS/GPT-SoVITS 无 ARM 优化，只有 **Kokoro ONNX（~100MB，projectBEA）和 Edge-TTS（云，Nexus 默认）** 是可行的嵌入式 TTS 出路。**chat-A 必须从 day 1 把 TTS 做成可换 provider，否则嵌入式后路被堵死。**

## 2. 横向对比表

| 项目簇 | 部署形态 | 是否分档 | 关键轻量化手段 | 模型选型 / 本地云切换 | 最值得借鉴点 |
|---|---|---|---|---|---|
| **Neuro SDK + core** | PC 高端单机(12GB VRAM)/ AIRI 云 | ❌ 无 profile、无降级 | validate-before-execute 三段式、MessageQueue 折叠 | LLM 写死 Llama-3-8B EXL2；STT faster-whisper tiny 固定；TTS 无本地替代 | validate-before-execute 降延迟；**反面教材：无轻量化入口** |
| **Open-LLM-VTuber** | PC(Ollama)+ 云可换 + Pi 降级路径 | ✅ **YAML 零代码分档** | 能力哨兵降级、Factory、模块级 diff 重建 | STT/TTS/LLM 全 Factory+YAML；LLM 本地↔云一行切；**ASR/TTS 无降级(需补)** | **整套分档+切换架构可直接抄**；Pi 估算 1.2GB(Llama.cpp 2B Q8 + Sherpa-ONNX 纯 CPU) |
| **实时语音管线** | 三阶段：全云/混合/离线全本地 | ✅ **显式三 profile** | int8 量化、EOU-ONNX-Q8、10ms 帧切片双队列、自适应 jitter | STT/TTS/LLM 全参数化{model,device,compute_type} | generation 计数器打断、自校准延迟预算、有界队列反压——**语音延迟核心** |
| **Zerolan 生态** | PC 本地优先 + HTTP 微服务拆分 + 可选云 | ✅ 多粒度量化(2/4/8-bit) | GGUF 量化自选、HTTP 微服务、enable_clause_split | 完整模型能力表(显存数值)；Ollama 兜底；ASR/TTS 无本地轻量→REST 回源 | **模型能力表 = 降级 SOP 模板**；config[model_id] 子字典范式 |
| **AIRI + projectBEA** | Electron PC 主 + Web 次 + 云 failover | ⚠️ Web-day-one 但 Pi 仅理论 | TTS chunker(Intl.Segmenter)、Kokoro ONNX、priority 分级、bullet 上下文 | xsai 多 provider；projectBEA 三级 TTS(EdgeTTS→Kokoro→Orpheus)+ multikey failover | **Kokoro ONNX 本地 TTS(嵌入式唯一现成出路)**、TTS chunker 降 TTFA、skill 热重载 |
| **Nexus** | Electron 桌面；local-first(Ollama)+ 云备 | ⚠️ PC-first 但**预留轻量化空间** | local-hash-v1 默认零依赖嵌入、idle 状态机节流、0.97^days 衰减+冷归档、懒加载 | STT sherpa-onnx 本地/云；TTS Edge-TTS 默认；LLM 19-provider failover；成本闸门 | **failover orchestrator(~100行)**、idle 状态机(PC 30s/低功耗慢 tick 同代码)、流式 chunker |
| **LingYa + eros_ai** | PC/服务端 + 可降级单机 | ✅ 人格情绪完全本地无 LLM | OCC+PAD+OCEAN 确定性计算、人格 Pass2 纯 Python δ、衰减惰性 | LingYa DeepSeek↔Ollama 环境变量切；eros_ai 云依赖重 | **人格/情绪引擎可完全离线(≤512MB)**——嵌入式最友好的认知模块 |
| **memory-frameworks** | PC/Server(pgvector)+ Pi 降级(SQLite+FastEmbed) | ✅ profile 隐式(optional-deps) | FastEmbed/Ollama 本地嵌入(384维18MB)、SQLite BLOB 全表扫、ADD-only+SimHash、衰减只读 | 5 类嵌入可插拔；PC OpenAI 1536维 / Pi FastEmbed 384维 <100ms | **ADD-only 热路径 + 后台异步整合**、衰减只读离线算、salience 分层 |

## 3. 可借鉴的轻量化技术清单（按主题）

### A. 模型选型与量化
1. **量化模型能力表作为降级 SOP**（已验证）。来源：Zerolan `zerolan-core/README.md:98-113`（GLM-4-9B-GGUF Q2_K=3.99GB/可树莓派 vs Q4_K=5.3GB vs fp32=18GB）。落地（§5.6）：改造成 chat-A「PC/嵌入式候选模型库 + 降级规则」，每档明确 {model_id, device, compute_type, RAM/显存, 是否流式}。
2. **STT 三档量化**（已验证）。来源：`voice-core/main.py:82-84`（whisper tiny-int8-39MB / base-fp16-73MB / small）；Open-LLM-VTuber 集成 Sherpa-ONNX（纯 CPU）+ Whisper.cpp。落地：`create_stt_adapter(model_id, device, compute_type)`，PC=base/small+fp16+CUDA，Pi=tiny+int8+CPU。
3. **LLM 本地量化路线**（已验证）。来源：Open-LLM-VTuber Llama.cpp GGUF。落地：写 chat-A Llama.cpp 量化 runbook，自动化 Pi 准备。
4. **TTS 是嵌入式唯一硬约束**（部分证据+推断）。Kokoro ONNX（projectBEA `kokoro_tts_wrapper.py:17-50`，~100MB，24kHz，自动下载）+ Edge-TTS（Nexus 默认，云免费流式）是仅有出路。落地：Kokoro ONNX 作可选本地 TTS provider（启动检测 GPU 自动选），Edge-TTS 作云端轻量兜底。

### B. 本地-云后端可切换
5. **Factory + YAML 零代码切换**（已验证，**最高优先级抄**）。来源：Open-LLM-VTuber `asr_factory.py:5-62 / tts_factory.py:5-150 / stateless_llm_factory.py:14-78`（11 个 LLM provider 全靠 conf.yaml，无 if/else 无重启）。落地（接缝）：STT/TTS/LLM/嵌入/人格五类后端全走同一 Factory + discriminated-union 子配置。**这是「不堵死嵌入式后路」的物理基础。**
6. **模块级 diff 重建**（已验证）。来源：`service_context.py:324-362`（只重建变化的模块，相同配置复用引擎，消除模型重载延迟）。
7. **能力哨兵优雅降级**（已验证，嵌入式必备）。来源：`openai_compatible_llm.py:216-223`（不支持 tool→yield `__API_NOT_SUPPORT_TOOLS__`→切 prompt 模式 + 括号配平 JSON 检测 `mcpp/json_detector.py:90-121`）。Pi 本地小模型常无 tool 支持，机制自动触发。落地（§5.9+接缝）：provider 带 support_tools 标志，扩三段式（尝试→哨兵切 prompt→可选 retry 预算）。
8. **多 provider failover + 指数退避**（已验证）。来源：Nexus `failover/orchestrator.ts`（~100行通用）；projectBEA Gemini→OpenAI→Groq→GLM 退避 [60s,5m,25m,1h] + 成本闸门 dailyCapUsd。落地：LLM/STT/TTS 共用一套；identity=`provider|key|model` per-key 退避。
9. **STT/TTS 也要降级（参考项目的缺口）**（已验证缺口）。落地：ASR 失败→纯文本输入；TTS 失败→只显示文本无音频。

### C. 延迟与流式
10. **generation 计数器打断框架**（已验证，语音延迟核心）。来源：voice-core `orchestrator.py:66-68,152-166`（generation+processor_id 双重检查 + cancel_token 三件套）；RealtimeVoiceChat `speech_pipeline_manager.py:184-189`；neuro-sdk MessageQueue 折叠 + SendImmediate 旁路。落地（接缝2）：跨网络每帧带 generation 标签；弱网/Pi MessageQueue 折叠价值大。
11. **流式 TTS chunker 降 TTFA**（已验证）。来源：AIRI `tts-chunker.ts:59-80`（Intl.Segmenter + 硬/软标点 + 强制首 1-2 句早出，降 TTFA 200-400ms）；Nexus `streamingTts.ts`（18-72 字窗口）。落地：替换 naive sentence-split；**CJK 必须用 grapheme count 而非 word count**（avoid：Intl.Segmenter 对中文按字算会切碎）。
12. **自校准延迟预算**（已验证，PC/Pi 自动适配）。来源：RealtimeVoiceChat `speech_pipeline_manager.py:170-172`（启动期实测 TTFT/TTFA 反馈为静音等待下限）；LiveKit 动态端点 EOU 概率+EMA（`endpointing.py:49`，中文阈值 0.3550）。落地：阈值不写死，Pi/PC 自动适配。
13. **10ms 帧切片 + 双队列反压**（已验证）。来源：Pipecat `frame_processor.py:119-167,735-741`、`base_output.py:123-135`；voice-core `audio_queue.py:32-90`。落地：RuntimeEngine B 层 + TTS jitter buffer；**Pi 用 latency='low'(50ms) 不要 'high'(200ms)**。
14. **bullet-list 上下文 + KV-cache 复用**（已验证，弱模型友好）。来源：AIRI `context-prompt.ts:30-49`（8B/14B 会把 `<context>` XML 当数据回吐→用 `[Context]\n- key: value`；字节稳定 system 前缀 + 易变上下文只放最后一条 user 消息）。落地（§5.4 PromptContributor）：省 15-20% token + 跨轮 KV-cache 复用。

### D. 部署分档与能力门
15. **YAML 单文件控制 + provider 自适配**（已验证）。来源：Open-LLM-VTuber sherpa-onnx `provider=cuda/cpu` 自动检测、faster-whisper `device=auto`（`sherpa_onnx_asr.py:72-85`）。落地（§5.6）：profile gate `--target pc|raspberry|browser`，差异全在配置 + Factory，代码零分叉；但要 **fail-fast 声明能力**（加载前检查 CUDA，不是失败后回退）。
16. **idle 状态机一套代码两档**（已验证）。来源：Nexus `tickLoop.ts + focusAwareness.ts`（~200行，active/idle/away/locked，awake→drowsy→sleeping→dreaming）；`emotionModel.ts:119-181`。落地（§5.6）：同代码 PC=30s tick，低功耗=慢 tick；后台技能全 config 开关，树莓派默认 disable。
17. **skill 热重载 + per-tick enabled**（已验证）。来源：projectBEA `skill_manager.py:53-62 / base_skill.py:34-36`（config.enabled 每 tick 读 getter，inflight lock，五钩子生命周期）。落地：**每个 skill.update() 包 wait_for(1s)**（avoid：慢 skill 阻塞全部）。**※ chat-A autonomy 已按此范式实现。**

### E. 记忆与检索足迹
18. **SQLite + 本地嵌入 + 无向量库**（已验证，嵌入式记忆基线）。来源：mem0 `fastembed.py:15-19`（gte-large 384维18MB自下载）；OpenMemory `vector_store.py:35-89`（SQLite BLOB 全表扫余弦，无 ANN）；Nexus local-hash-v1（FNV-1a Hash256 零依赖）。落地（§5）：**embedding 默认本地、向量库默认禁用**；BLOB 不透明存储便于中途换嵌入模型（re-embed 后台写回同列）。
19. **ADD-only 热路径 + SimHash 去重 + 异步整合**（已验证）。来源：mem0 `main.py:798-937`（ADD-only，MD5 命中零 LLM；v2.0.7 已废弃 LLM update/delete，误报>10%）；OpenMemory `hsg.py:165-198`（SimHash 64位 Hamming 3）；Letta `sleeptime_multi_agent_v2.py:114-120`（fire-and-forget 整合）。落地（§5.8）：**热路径绝不调 LLM 决策「是否更新」**；整合放后台。**※ chat-A 写路径已按此设计。**
20. **衰减只读 + salience 分层**（已验证）。来源：OpenMemory `decay.py:152-154`（`f=exp(-λ_tier·dt/(sal+ε))`）；Nexus `decay.ts`（0.97^days，半衰期23天，score<0.15 冷归档可恢复）。落地（§5.6）：统一 `0.5^(days/H)`，H←salience 桶；**查询时 SQL 实时算，不批量写回**（memoripy 毫秒级写回 Pi CPU 扛不住）。10k 条 384维 ≈ 46MB。**※ chat-A 已为单一权威公式 + 惰性计算。**

### F. 人格情绪计算成本
21. **OCC+PAD+OCEAN 完全确定性（零 LLM）**（已验证，嵌入式最友好认知）。来源：LingYa `affect.py:70-130`（OCC 22-emotion 决策树）、`affect.py:328-365`（PAD Mehrabian P=0.21E+0.27A-0.20N+0.14O+0.08C）、`affect.py:368-405`（PAD 弹簧 k=0.2交互/0.01空闲）；eros_ai 人格 Pass2 纯 Python δ。≤512MB 常驻可跑。落地（§6）：人格/情绪默认完全本地无 LLM，LLM 情感评估作可选增强。**※ chat-A 已落地此接缝。**
22. **冷启动情绪减半 + 加速弹簧回弹**（已验证原理 + chat-A 改良）。来源：LingYa `tone.py:14-45`。**※ chat-A 已实现冷启动机制。**

## 4. 反模式 / 要避开的重负担

| 反模式 | 来源/证据 | 为何不适合嵌入式/单机 |
|---|---|---|
| 无条件引 transformers/ChromaDB/Milvus | Neuro `requirements.txt`；Zerolan 强依赖 Milvus | 5GB+ 包、向量 DB 常驻；应 SQLite+sqlite-vec 本地 |
| 硬编码 if/else 后端选择 | Neuro `constants.py` 写死 LLM_ENDPOINT | 后端决策散落，无法分档切换 |
| 全局可变 Signals + setter 副作用 | Neuro `signals.py:21-58` | 竞态 + 因果模糊，与可追溯冲突 |
| isolated-vm 每回合 fork 跑 JS | AIRI | 过度工程 + 延迟杀手 |
| agentic 工具调用记忆操作 | Letta `core_tool_executor.py:278-344` | tool→LLM→tool 循环杀实时延迟 |
| 毫秒级衰减写回 | memoripy `memory_store.py:85` | Pi CPU 扛不住；用离线只读 |
| 双衰减/双打分体系冲突 | OpenMemory decay vs hsg；Nexus 双轨 | parity bug 难抓；统一单一权威公式 |
| 全表余弦扫描无 ANN | OpenMemory `vector_store.py:67-89` | <50k 可用，500k 崩；嵌入式接受 O(n) 但 n<10k |
| CoquiTTS/GPT-SoVITS 作唯一 TTS | Neuro/Zerolan | 嵌入式无路；必须 Kokoro/Edge-TTS 兜底 |
| 无心跳/重连/背压/帧序号 | RealtimeVoiceChat / AIRI 浏览器模式 | 弱网/跨机直接挂；chat-A §4 全要自补 |
| 把「人格」建模在用户身上以讨好 | eros_ai（反面教材） | 正是 chat-A 北极星要拒绝的助手范式 |
| XML `<context>` 标签喂小模型 | AIRI（被 8B/14B 回吐） | 用 bullet list 追加 |
| CJK 按 word count 切 TTS | AIRI tts-chunker | 中文切碎、TTFA 不均；用 grapheme count |

## 5. 对 chat-A 当前策略的修正建议

### 现在就埋接缝（零成本，堵死后路代价高）
1. **Factory + discriminated-union 配置（最高优先）**——STT/TTS/LLM/嵌入/人格五类后端全走 `create_X_adapter(model_id, device, compute_type)`（Open-LLM-VTuber `asr_factory.py:5-62`）。**分档的物理基础，后补代价极大。**
2. **profile gate `--target pc|raspberry|browser`**——差异全落配置 + Factory，代码不分叉（§5.6）。即使现在只实现 pc 档，接缝先留好 device/compute_type 字段。
3. **能力门 + fail-fast 声明**——provider 带 `support_tools`/`support_streaming`/`requires_cuda`，加载前检查能力，不支持就 fail-fast 或哨兵降级（避免状态歧义）。
4. **generation 标签贯穿全管线**——打断/帧/记忆/事件总线全带 generation + correlationId/causationId（voice-core + Zerolan）。跨机/弱网必需，且服务 §8.1 可追溯。
5. **记忆 BLOB 不透明存储 + 衰减只读**——SQLite 向量存 BLOB（对 schema 不透明），衰减只读离线算。换嵌入模型时后台 re-embed 写回同列，无 schema 迁移。
6. **人格/情绪引擎纯本地确定性**——OCC+PAD+OCEAN 全本地（LingYa 验证 ≤512MB），LLM 情感评估只作可选增强。

### 以后再填（接缝留好，实现延后）
- **Pi 量化 runbook**：Llama.cpp GGUF + Kokoro ONNX TTS + Sherpa-ONNX STT 自动化准备（目标 ~1.2GB 纯 CPU）。
- **STT/TTS 降级链**：ASR 失败→文本输入；TTS 失败→纯文本显示。
- **idle 状态机低功耗档**：同代码慢 tick，后台技能 config 默认 disable。
- **failover orchestrator + 成本闸门**：Nexus ~100 行通用，LLM/STT/TTS 共用。
- **MessageQueue 折叠 + 自校准延迟预算**：弱网带宽优化 + Pi/PC 阈值自适配。

### PC 优先具体怎么做才不堵死后路
- **不写死任何后端**（对照 Neuro `constants.py` 反面）；**不无条件引重依赖**（transformers/ChromaDB/Milvus 全作 optional-dependencies）。
- **无 ARM 路径的硬依赖不进核心层**（CoquiTTS/GPT-SoVITS 只作可选 PC provider，核心默认 Kokoro/Edge-TTS）。
- **延迟阈值全自校准、不写死**（LiveKit 范式），PC/Pi 同代码自适配。

## 6. 证据与不确定性

### 已验证（有路径证据）
- 无一项目有 Pi 原生推理：AIRI cluster「NONE have Pi-native inference」；Nexus `README.md:49-110`「NO embedded target」；Neuro `requirements.txt`。
- 零代码切换可行：Open-LLM-VTuber `service_context.py:324-362`、`asr_factory.py:5-62`、`openai_compatible_llm.py:216-223`。
- 嵌入式记忆基线可行：mem0 `fastembed.py:15-19`、OpenMemory `vector_store.py:35-89`；mem0 v2.0.7 废弃 LLM update/delete。
- 人格情绪可全本地：LingYa `affect.py:70-130,328-405`；eros_ai `personality_update.py:66-127`。
- TTS 约束 + Kokoro 出路：projectBEA `kokoro_tts_wrapper.py:17-50`。
- 语音延迟接缝：voice-core `orchestrator.py:66-68,152-166`；Pipecat `frame_processor.py:119-167`；LiveKit `endpointing.py:49`。

### 需进一步精读 / 实测（诚实标注）
1. **Pi 实测延迟全是估算（推断）**：「Llama.cpp 2B Q8 + Sherpa-ONNX = 1.2GB / 完全本地 TTFA 4-5s / ollama 7B q4 1-2s/token」均为推算，**应在真实树莓派 4B/5 上实测一次**再定阈值。
2. **Kokoro ONNX 在 ARM 上的实际表现未验证**：projectBEA 在 x86 用，ARM/Pi 合成延迟与内存无证据，需实测。
3. **CoquiTTS/GPT-SoVITS 无 ARM 优化是结构推断**（基于「未提及 ARM 版本」），非「不能编译」的确证。
4. **Letta 后台整合 timeout/降级细节未读全**（agentic 记忆已判定避开）。
5. **AIRI WebGPU 浏览器档纯理论**：建议浏览器档只做 UI/渲染、推理回源。
6. **sqlite-vec 在 Pi/ARM 上的编译与 ANN 性能未测**：n<10k 接受 O(n)。
