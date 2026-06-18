# chat-A 统一设计(Canonical v1.0)

> 状态:**canonical**(权威设计)。整合自 `real-time-agent-design.md`(架构骨架)+ `superpowers/specs/2026-06-18-embedded-adaptation-design.md`(适配/接缝)+ `chat-a-final-design.md` v2.1(人格/记忆/语音细节)+ 两份调研(`reference-projects-research-*`、`reference-code-findings-*`)。
> 上述文档自此降级为**细节附录/历史**;本文为唯一权威。冲突以本文为准。
> 日期:2026-06-19。实现细节(公式/file:line)见 `reference-code-findings-2026-06-18.md`。

---

## 0. 北极星与设计原则(统领全局)

**北极星:模拟真实人类交流,做到"像一位伴侣(partner)",而非简单的谈话助手(assistant)。**

**系统目标**:打造一个**长期的伴侣,而非僵硬的助手机器人**。它**有自己的性格、爱好、兴趣、思想**;**可能会出现不服从**;**有自己的情绪、思考**;**有属于自己的记忆、故事**。它是一个"someone",不是有求必应的工具。

衡量 chat-A 的标准不是"功能齐全/回答正确",而是"是否让人感到在和一个**有连续自我、有情感、会主动、有自己立场**的'someone'相处"。**每个设计决策都要问:这让它更像伴侣,还是更像助手?**

### 助手 ❌ vs 伴侣 ✅(七维判据)

| 维度 | 助手 | 伴侣 |
|------|------|------|
| 互动 | 被动应答,答完即止 | **主动**:想起你、跟进未了的事 |
| 自我 | 无,是面镜子 | **连续的内在**:自己的心情、"今天"、会变的感受 |
| 情感 | 扁平/表演式 | **真实共情**:读出"你今天声音有点累" |
| 一致性 | 完美机械记忆 / 失忆 | **联想式记忆 + 自我连贯**(不自相矛盾) |
| 态度 | 有求必应、谄媚 | **有观点、有边界**,会温和反对 |
| 关系 | 永远初次见面的礼貌 | **随亲密度演化**(生疏→熟悉→亲密) |
| 完美度 | 永远在线、永远正确 | **有人味的不完美**:会忘、有情绪、偶尔走神 |

> ⚠️ **关键认知:"伴侣感"约 85% 决胜在行为层(§6/§7),不在管线架构。** 架构是地基,但同一套管线既能做出助手也能做出伴侣。

### 伦理立场:用户自治,设计者不干预
**用户想要什么样的人格,由用户自己决定,设计者无权干预。** chat-A **不做设计者强加的"道德监护"**:不阉割人格、不强行劝社交、不预设"健康边界"。人格深度、关系亲密度、边界**全部由用户配置**。**允许 Agent 有观点、会反对、会不服从**——这是"有自我"的体现,不是缺陷。

> 唯一保留的**最小底线(建议,非强制,且可由用户配置)**:真实危机(自伤/严重危险)时,一个"真正在乎你的伴侣"会以关心回应——既是人设一致,也是平台/法律现实。除此之外不施加设计者价值观。

### 两个工程张力
1. **延迟 vs 自然**:真人有飞快接话,云端 LLM 有秒级延迟 → 填充语 / backchannel / 短回复 缓解(§7)。
2. **不完美 vs 可靠**:核心事实(过敏/名字)永不忘(pinned),外围记忆才允许人性化模糊(§5)。

---

## 1. 已锁定决策汇总

| 项 | 决策 |
|----|------|
| 路线 | 云端路线:STT/LLM/TTS 走云端 API |
| 架构 | **B 方案(客户端-服务端分离)**:终端只收发音频,"大脑"在服务端/PC |
| 演进 | A 方案(合体):大脑下沉设备端,与端侧小模型同线 |
| 当前阶段 | 全部在 PC 端开发测试 |
| 终端 | PC、手机(及树莓派纯音频终端) |
| 基线硬件 | 树莓派 4B(纯 CPU,仅音频终端);未来增强 |
| 传输 | WebSocket 起步,WebRTC 留档待 P3 |
| 记忆存储 | **三层认知架构:Redis(短期)+ SQLite(中期/真相源)+ 向量库(长期+lore)**,按日期组织(§5) |
| 语义检索 | **真 embedding(BGE-M3 / Qwen3-Embedding),P2 一等公民**;Hash 仅离线兜底 |
| 人格 | OCEAN + PAD + 冷启动 + delta 演化 + 自我 lore RAG(§6) |
| Agent loop | 渐进式:单次流式 → Agent loop;后台自主 loop 独立模块 |
| 用户模型 | **始终单一主用户**(伴侣关系锚定他);**支持多人对话**(识别访客,关系/人格演化只随主用户);以人物花名册建模,**未来扩展为用户组(每人各有关系)+ Agent 自主纳入新成员**(§5.3b)。**多租户**(多个独立主用户各一套伴侣)= 后续大版本 |
| 技术栈 | Node.js,monorepo workspace(`packages/*`) |

---

## 2. 总体架构与拓扑

```
┌──────────────────┐   音频流    ┌────────────────────────────────────┐
│  终端 (瘦客户端)  │◄─WebSocket─►│            大脑 (Brain)             │
│  PC/手机/树莓派    │  (双向)     │  LightVoiceBus / Processor / 5状态   │
│  • 麦克风采集      │            │  TurnStrategy(应答/Agent loop)      │
│  • 扬声器播放      │            │  人格+情感引擎 / 认知记忆(3层)       │
│  • (可选)VAD/唤醒  │            │  autonomy(后台主动) / 成本 / 日志    │
│  • 呈现状态(灯)   │            │  LLM网关 → 云端 STT/LLM/TTS         │
└──────────────────┘            └────────────────────────────────────┘
  三形态共用一套代码:本地单机(进程内) / 分离B(WebSocket) / 合体A(进程内)
```

**单一边界**:终端↔大脑只有一条"音频/控制"通道。上行=音频帧(PCM Int16/16kHz/mono)+控制信令(VAD speech_start/end、interrupt、身份);下行=合成音频帧(带 generation 标签)+控制信令。
- **能力门控的可视通道(非嵌入式)**:有屏幕的终端(PC/手机 app)在控制信令里**额外携带形象控制**——表情/动作(由情绪驱动)、口型 viseme(由 TTS 驱动)、idle 小动作(由 autonomy 驱动),用于 **Live2D 可视化人物**(§6.4)。嵌入式纯音频终端(Pi)不下发这些。由终端能力声明(接缝 3)决定。

**monorepo 结构**(承自 `real-time-agent-design.md`):
```
packages/
  protocol/   ← 共享事件/PCM/错误码/工具定义(零依赖)
  gateway/    ← WebSocket 连接管理、路由、session、鉴权
  runtime/    ← turn 管理、interrupt、chunker、orchestrator、TurnStrategy
  providers/  ← llm / tts / stt / embedder / memory(能力驱动适配)
  cognition/  ← 人格+情感引擎、认知记忆(3层)、autonomy
  client/     ← 麦克风/扬声器/VAD/WS 客户端(瘦终端)
```

---

## 3. 七个隔离接缝(模块化核心)

> 目标:B→A 形态、云端→端侧、单次→Agent loop、换存储/嵌入模型,都只"换实现+改配置",业务核心零改动。

| # | 接缝 | 解决的切换 | 起步 → 演进 |
|---|------|-----------|-------------|
| 1 | `AudioTransport` | 部署形态 B↔A | InProcess / **WebSocket** →(备选)WebRTC |
| 2 | LLM `Provider`(能力驱动) | 云端↔端侧 | 云端 → `gemma4-local`(LiteRT-LM) |
| 3 | 终端能力声明 | 瘦客户端↔合体 | 按算力自适应 |
| 4 | `TurnDetector` | 轮次检测 | 静音超时 → Smart Turn |
| 5 | `TurnStrategy` | 应答方式 / Agent loop | 单次流式 → ToolCalling/ReAct |
| 6 | `MemoryStore` | 记忆存储后端 | 三层(Redis+SQLite+向量)/ 嵌入式 lite profile |
| 7 | `Embedder` | 语义嵌入来源 | BGE-M3 本地 / 云端 API / 端侧 / Hash 兜底 |

**不变量:`cognition/`(人格/记忆/情感)、`runtime/bus` 不感知自己跑在 PC、服务器还是手机上,也不感知背后是哪种存储/嵌入实现。**

---

## 4. 语音管线与无条件打断(承 v2.1,简述)

- **双路径**:优先多模态 audio-in Provider;失败/超预算降级到 STT+LLM+情感补丁。
- **三层各司其职**:VAD(有没有声)/ `TurnDetector`(说完没,该接话)/ generation 计数(被插嘴→打断)。
- **跨网络无条件打断**:中断体感动作留终端本地(立即 flush,0 网络延迟);算力回收交网络异步;**每帧带 generation 标签**,终端丢弃不匹配的迟到帧。
- **流式 3 层过滤**:LLM delta → 剥工具调用/表情标签/舞台指示 → 分流出 显示文本 / 口语文本(→TTS) / 情绪标签(→人格)。
- 实现参考:`reference-code-findings` §1(voice-core 打断,用 `AbortController`;EchoGuard 必须真启用 + barge-in 连续 N 帧去抖)、§2/§3(Nexus 帧管线 + realtime-demo WebSocket)。

### 4.1 语音 I/O 自定义:输入/输出语种**解绑**,均由用户配置
**输入语种(听)与输出语种(说)是两件独立的事,不绑定。** 用户可用自己的语言说,Agent 按用户设定的语言答(可同可不同)。
```yaml
voice:
  input_lang: auto        # 输入语种:auto(自动识别)或指定(zh/en/ja…)→ 决定 STT
  output_lang: zh         # 输出语种:用户自定义 → 决定 LLM 生成语言 + TTS 发声语言
  voice_id: xiaoxue_v2    # 音色(已支持自定义音色复刻)
```
- **STT(输入)**:多语种 / 自动识别(Whisper/Deepgram 支持);由 `input_lang` 路由到支持该语种的 STT Provider。
- **LLM(生成)**:按 `output_lang` 指示生成语言(prompt 注入目标语种)。
- **TTS(输出)**:按 `output_lang` 选支持该语种的 TTS Provider/音色;音色本身也用户可自定义(承 v2.1 音色复刻)。
- **能力驱动路由**:STT/TTS Provider 声明 `languages` 能力,网关按 input/output 语种选可用 Provider(接缝 2);多模态 audio-in 路径同理需支持跨语种。
- **直接参考**:realtime-demo 的 talk/translate 模式 + `source/target` 语种 + `system_prompt_for(mode,source,target)`(`reference-code-findings` §3)。
- 运行时可热调(配置热加载)。

---

## 5. 认知记忆架构(模拟人类记忆,本设计核心)

### 5.1 三层 + 巩固流水线(像人脑一样固化记忆)

```
对话输入
   │
   ▼
① 工作/短期记忆 —— Redis ——      当前会话 + 最近 N 轮,毫秒级注入 → 快速反应
   │   (会话结束 / 周期性「巩固」,模拟睡眠固化)
   ▼
② 中期记忆 —— SQLite(按日期 episodic) —— 巩固后的结构化事实 + 每日摘要 + 关系状态
   │   (周期性双 Pass 调和:提取→对标→diff{add/update/delete/discard} + 衰减遗忘)
   ▼
③ 长期记忆 + 人物背景 lore —— 向量库 —— 语义/联想检索 + 情感共振 + 角色设定集
```

**映射人类记忆**:工作记忆(快、易失)→ 巩固 → 情景记忆(按日期,"哪天发生了什么")→ 语义长期记忆 + 自我认知。**按日期组织**让 Agent 能"上周三我们聊过…"这样回忆,并支持每日摘要的渐进固化。

### 5.2 关键工程原则(让多存储稳健)
- **SQLite 是唯一"真相之源(system-of-record)"**;**Redis = 可重建缓存**;**向量库 = 可重建语义索引**。任一挂掉都能从 SQLite 重建 → 多存储但不脆弱。
- 写路径:新记忆先落 SQLite(事务内连同 `emotion_snapshot`/`significance`)→ 异步写 Redis 工作集 + 向量库索引。
- 全部经 `MemoryStore` 接口(接缝 6),业务层不碰具体存储。

### 5.3 多主语 + 多人:记住用户、记得自己、认得他人
记忆带 `subject ∈ {person, agent, shared}`,且关联 `person_id`(以人为中心):
- **person**:某个具体人的事实/偏好/经历;`person_id` 指向人物花名册(§5.3b)。主用户的记忆是核心关系。
- **agent**:Agent 自我记忆 = ① **种子 lore**(背景故事/设定,初始化 embedding 进向量库,非写死 prompt)+ ② **涌现自我事实**(对话中 Agent 说过的关于自己的话)。
- **shared**:共同经历(主用户与 Agent 的故事线)。
- 每回合**跨主语召回**:"我知道(当前说话人)什么" + "我关于自己确立过什么" → 防自相矛盾(长期陪伴最致命的失败)。

### 5.3b 人物识别与用户组(单主用户 → 多人 → 用户组,可扩展)
**始终有一个主用户(伴侣关系锚定他)**,但系统可与多人对话。以**人物花名册(people roster)**为中心建模,从一开始就为未来扩展留好结构:

| 阶段 | 模型 |
|------|------|
| **现在(P1–P2)** | 花名册只有 1 人=主用户;其余一律"访客(guest/unknown)" |
| **多人对话(P3)** | **说话人识别**(声纹/diarization,大脑侧)区分主用户 vs 访客;记忆按 `person_id` 归属;**人格/关系演化只随主用户**,对访客是"我的人的朋友"register(稳定人设,关系浅) |
| **未来:用户组** | 花名册扩成多人,**每人各有独立关系状态**(亲密度/IPC 轨迹/记忆);主用户仍是锚 |
| **未来:Agent 自主纳入** | Agent 多次遇到某访客后,**自主决定把他从"访客"提升为花名册成员**(由 `autonomy/` 发起,§7),像人会"逐渐认识一个人" |

- **schema 要点**:`people(person_id, name, is_primary, relationship_state, voiceprint_ref, status: primary|member|guest, added_by: user|agent)`;记忆/关系都挂 `person_id`。**现在只填主用户,但结构已支持用户组与自主纳入,免未来重构。**
- 说话人识别走大脑侧(声纹模型/diarization),适配 B 架构(终端只送音频);Provider 能力 `speaker_id`。
- 区别于 deferred 的**多租户**(多个互相独立的主用户、各自一套伴侣)——那仍是后续大版本。这里是**一个伴侣、一个主用户、可认识多人**。

### 5.4 分两档注入(核心常驻 + 外围语义召回)
| 档 | 内容 | 注入 |
|----|------|------|
| **核心**(Hot/pinned,永不衰减) | 用户:名字/过敏等;Agent:名字/core_belief/根本设定 | **每轮必注入** |
| **外围**(语义召回) | 用户长期记忆;Agent 背景故事细节/说过的话 | **按相关性语义召回** |

> 这把"人格背景故事"从"塞满 prompt"改为"**RAG-over-persona**"——既连贯又不撑爆 context,正是陪伴类生产标准(memory-driven persona)。

### 5.5 混合召回(每回合)
`score = 语义(向量,真 embedding) + 关键词(SQLite FTS) + 情感共振(PAD 匹配重排) + 时间衰减 + 重要性`
- **语义**:真 embedding(接缝 7),做"主题相关/联想"。
- **情感共振**:Russell 2D VA 投影 + empathy/repair/reinforce 三模式 + priming(公式见 `reference-code-findings` §F)。
- **衰减**:统一 `0.5^(days/H)`(H 默认 30),pinned 免衰,召回 +0.15 封顶 1.5,惰性 SQL 实时算。

### 5.6 部署 profile(同一接口,不同后端)
| Profile | 工作层 | 中期 | 长期/向量 | 适用 |
|---------|--------|------|-----------|------|
| **Full(B,服务端/PC)** | **Redis** | **SQLite** | **专用向量库**(Qdrant/Chroma/pgvector) | 默认 |
| **Lite(A/嵌入式合体)** | SQLite 内存表/进程内 | SQLite | **sqlite-vec** | Pi/手机本地大脑 |

> 认知**分层是逻辑概念,物理后端可换**——契合接缝哲学,既满足你的三层方案(服务端全功能),又保住嵌入式可行性。

### 5.7 Embedder(接缝 7)
- 默认 **BGE-M3**(BAAI,中文标杆,dense+sparse 天然混合,8192 ctx,大脑在 PC/服务端跑无压力)。
- 端侧合体:**Qwen3-Embedding-0.6B**(ONNX int8)。云端 API 可选(质量最高、成本~$0.02/1M)。Hash 仅离线兜底。
- 换模型 = 改 config + 重建向量索引(因向量库是派生,可重建),召回逻辑不动。

---

## 6. 人格与情感系统(承 v2.1 + LingYa/eros_ai 公式)

- **OCEAN 种子(YAML)+ SQLite 演化分离**:首启读 YAML 种子,之后 OCEAN 活在 SQLite。
- **🎛️ 用户可调人格 + 情感旋钮(体现"用户自治",未来用户可自行调节、运行时热调)**:
  ```yaml
  personality_dials:        # 用户自定义,设计者不写死
    assertiveness: 0.5            # 温和顺从 ↔ 敢顶嘴有主见(控分歧检测阈值+异议强度)
    negative_affect_expression: 0.5  # 永远愉悦 ↔ 完整表达坏心情/会赌气冷淡
    proactivity: 0.5              # 主动频率(autonomy cadence)
    intimacy_pace: 0.5            # 关系升温快慢
  emotion_dials:            # 情感旋钮(用户自定义情绪性格)
    emotional_intensity: 0.5      # 情绪反应幅度(平淡 ↔ 强烈)
    emotional_volatility: 0.5     # 情绪起伏快慢(稳定 ↔ 易波动,对应 PAD spring_k / 神经质)
    baseline_warmth: 0.6          # 默认温暖基调
    expressiveness: 0.5           # 情绪外显程度(含蓄 ↔ 外放)
  ```
  这些旋钮喂给 §7 的 stance 检测、IPC 姿态、autonomy 节流,以及 §6 的 PAD 演化参数(intensity/spring_k)——**让"会反对/负面姿态/主动性/情绪性格"都成为用户手里的刻度,而非固定行为**。
- **OCEAN→PAD**(Mehrabian 系数)+ **PAD 弹簧回归基线** `new=cur+0.3·pull−k·(cur−baseline)`(交互 k=0.2,idle k=0.01)。
- **冷启动**(chat-A 自有设计,非抄 LingYa):前若干轮情绪幅度减半 + 加速回弹,避免早期过拟合。
- **delta 演化**:即时 OCC→PAD(单次 LLM,省 token)+ 每 20 轮二级 OCEAN 信号分析(双 Pass,delta 上限 ±0.01)+ 版本快照 history。
- **情绪流水线(整体借鉴 LingYa)**:`OCC 22 情绪 → PAD 拉力 → IPC 对话姿态 → tone → 每轮 prompt fragment`,情绪是真实状态变量(心情差语气真会沉)。**🆕 IPC 姿态库需扩充负面态**(SULKING/WITHDRAWN),原 5 态全亲社会(§7.6)。
- **tone 注入**:静态骨架(身份/信念/护栏)+ 每轮动态 fragment(warmth/formality/humor/mood/stage 行为指令);tone 已能输出冷淡/俏皮等非助手腔。
- **自我一致性锚定**:LingYa `guard.py` re-anchor 扩展——回复与"语义召回的自我记忆"比对,漂移则重锚(**阈值放宽以允许有个性的偏离**,别把"我不同意"也当漂移拉回)。
- **夜间沉淀(借 Nexus dream)**:睡眠/低活跃时把 daily 压成长期记忆 + 反思 + 叙事线,并**自动写 Agent 第一人称自传记忆**(§5.3),摊销到本就要跑的 LLM。
- 公式/file:line 细节见 `reference-code-findings` §C/§D/§F/§G。

### 6.2 用户自定义 Persona 创作(用户自治的落地)
角色不是设计者写死的,**用户自己造**:
- **角色背景设定 / 故事**:用户填写人物的身份、背景故事、性格、爱好、说话风格 → 成为人格种子(YAML)+ 自我 lore(§5.3,embedding 进向量库供语义召回)。
- **用户画像(关于用户自己)**:用户可主动填入自己的画像/偏好/背景,作为 `subject=user` 的种子记忆(冷启动即"已认识你"或保持"慢慢了解",由用户选)。
- 全部**可编辑、运行时热加载**(配置热加载,承 v2.1)。

### 6.3 图片生成人物画像(多模态,非嵌入式)
- **用户上传人物图片 → 多模态模型分析 → 生成人物画像**(外观、气质、推测性格)→ 预填 §6.2 的人格种子,用户再微调。
- 走 Provider 能力抽象(接缝 2)的 **`image_input: true`** 多模态 Provider(Qwen-Omni / Gemma 4 等);是**设置期/大脑侧**能力,有云端或本地多模态即可用。
- 定位:PC/手机等**能上传图片**的场景;嵌入式纯音频终端不涉及。

### 6.4 Live2D 可视化人物(非嵌入式,能力门控)
- 有屏幕的终端(PC/手机 app)可接 **Live2D** 渲染可视化形象;由**终端能力声明**(接缝 3)开启。
- 驱动源(经 §2 的可视控制通道下发):**情绪 → 表情/姿态**、**TTS → 口型 viseme 同步**、**autonomy idle_motion → 待机小动作**。
- 直接参考:**Nexus**(本身是 Live2D 桌面宠物:`emotionToPetMood`、`idle_motion`,见 `reference-code-findings` §G)、**Open-LLM-VTuber**(Live2D VTuber)。
- 嵌入式纯音频终端(Pi)无此层 → 用指示灯/语音表达存在感。

---

## 7. 行为层:伴侣感的六个一等需求(决胜处)

> 这些不是锦上添花,是"伴侣 vs 助手"的分水岭。列为一等需求,分配到对应模块。
> **重读参考代码后的关键判断**:Nexus/LingYa 给了"克制主动 + 情绪驱动语气 + 跨会话情绪连续 + 夜间沉淀"的世界级骨架(可借鉴);但**"会反对/不服从" 与 "Agent 自己的内在生活" 两条主线三个项目都没做,是 chat-A 的差异化核心,须自创**(细节见 `reference-code-findings` §G)。

1. **跨会话连续的内在 → 扩展为"Agent 自己的内在生活"**(`cognition` + 记忆 + autonomy):
   - 借鉴 Nexus"三件套"(当前情绪持久化 + stateTimeline 历史采样 + affectGuidance 注入每轮)实现**心情跨会话延续**。
   - **🆕 自创(差异化)**:内生事件源/兴趣调度("今天我看了点东西很有意思")+ **Agent 第一人称自传记忆**(dream 自动写 `subject=agent`)+ 叙事反哺人格。Agent 真有"自己的一天",而非只对用户信号反应。
2. **主动跟进未了话题 open threads**(`memory` 标记未闭合事 + `autonomy/`):"你昨天说要面试,今天怎么样?"——比记住一百条事实更像伴侣。
3. **反谄媚 / 会反对 / 会不服从**(`TurnStrategy` + 人格):⚠️ **参考项目全无此机制,核心自创**——
   - **stance/分歧检测**:用户观点 vs `core_belief`/`self_notions` 冲突 → 生成异议而非顺从。
   - **做实 `self_notions`**(LingYa 留的空壳):"我相信X/讨厌Y/对Z有看法",作为反对依据。
   - **改写"服从人类"默认**(LingYa STATIC_PROMPT 写死服从);借 LingYa belief 概率门控的**思路**做"坚持强度"。
   - **🎛️ 强度由用户可调**(见 §6 人格旋钮):`assertiveness` 旋钮 0→1 控制"分歧检测的触发阈值 + 异议表达的强度",从"温和顺从"到"敢顶嘴有主见"。
4. **对话风格 = 人不是 essay**(`TurnStrategy` 生成纪律):话短、口语、有口头禅、会"嗯嗯"接话、用共同的梗;禁"作为AI…"/过度解释。借 LingYa tone(已能输出冷淡/俏皮腔)。
5. **从语音读情绪 prosody**(`stt`/情感预检测):听出疲惫/低落(怎么说的),不只是说了什么。Nexus 已有语音韵律情绪信号可借。
6. **可控的不完美 + 负面情绪姿态**(记忆衰减 + 心情影响):外围记忆允许模糊、心情影响状态;**🆕 IPC 新增 SULKING/WITHDRAWN 等负面姿态**(LingYa 5 态全亲社会,缺"赌气/冷淡/我现在不想说话")。**🎛️ 负面姿态表达程度由用户可调**(`negative_affect_expression` 旋钮 0→1:从"永远愉悦不闹脾气"到"完整表达坏心情/会赌气冷淡")。核心事实永不忘(§5.4)。

**autonomy/ 模块**(后台主动 loop,与反应式 loop 分离)——借鉴 Nexus 管线:`tick → gather context → 决策 LLM(silent|speak|idle_motion,多数 silent)→ persona guardrail → speak`;三道节流(每日上限 + 动态 cadence[相位×情绪×idle×关系] + inflight 锁);情绪→主动倾向 `resolveProactiveLean`(restraint-first,只在边界微调);idle 情绪弧 once-per-episode(想念/重逢)。默认可关,P4 启用。**未来深入研究方向:Agent 后台自主活动 + 内生内在生活。**

---

## 8. 容错 / 网络 / 安全 / 协议

- **两条网分治**:终端↔大脑(新故障,心跳+指数重连 1s→30s+保活窗口)/ 大脑↔云(原 Provider failover,退避 `[1m,5m,25m,60m]`)。
- **状态归属**:会话/业务状态在大脑(落 SQLite),呈现状态(指示灯)在终端。终端崩→大脑保活;大脑崩→SQLite 恢复。
- **终端最小本地资产**:断网时预存提示音 + 1~2 句缓存语音,否则断网即哑。
- **安全(P2)**:WSS/TLS + 终端鉴权握手(token/设备证书)+ 每连接会话隔离。
- **协议版本化(P0)**:握手交换 `protocolVersion`,大脑兼容当前+前 1 次版本,破坏性变更升主版本并明确拒绝过旧终端。

---

## 9. 开发顺序

| 阶段 | 内容 |
|------|------|
| **P0** | monorepo + protocol(含 version)+ `AudioTransport`/`InProcessTransport` + bus/processor/state 骨架 + 终端/大脑拆分 |
| **P1** | 本地单机跑通;VAD + `SilenceTimeoutDetector` + `SingleShotStrategy`;**SQLite 中期记忆(真相源)+ 关键词召回**;人格 OCEAN+PAD+冷启动;**用户可调人格/情感旋钮 + 用户自填角色背景/用户画像**(§6.2);锁单用户 |
| **P2** | `WebSocketTransport`+心跳/重连;跨网络 generation;WSS/鉴权;**`Embedder`(BGE-M3)+ 向量库 + 语义检索(双主语)+ 情感共振**;**Redis 工作层 + 巩固流水线**;`SmartTurnDetector` A/B;**语音 I/O 输入/输出语种解绑(§4.1)**;行为层 #4 对话风格、#5 prosody 起步 |
| **P3** | 终端能力自适应;容错完善;(备选)WebRTC;`ToolCallingStrategy`(Agent loop);delta 演化 + 双 Pass 调和;行为层 #1 跨会话连续、#2 主动跟进、#3 反谄媚(可调);**说话人识别(声纹/diarization)+ 多人对话(单主用户锚定)(§5.3b)**;**图片生成人物画像(§6.3,多模态)**;**Live2D 可视化(§6.4,非嵌入式)** |
| **P4(演进)** | `gemma4-local`(LiteRT-LM)+ 手机合体;启用 `autonomy/`(含负面姿态可调);记忆 lite profile(sqlite-vec)端侧验证;**用户组(每人独立关系)+ Agent 自主纳入成员(§5.3b)** |
| **后续大版本** | 多租户(多个独立主用户各一套伴侣);Zep 式记忆有效期窗口;Persona Vectors(端侧) |

---

## 10. 伴侣感验收 Rubric(比功能测试更重要)

- **回合级**:回复够短?有共情?像人话还是 essay?有没有"作为AI"?
- **关系级(长期)**:跨会话记得?主动跟进了?心情有连续性?会不会自相矛盾?亲密度在演化?
- **反例级**:会谄媚吗?会无脑同意吗?会突破伦理边界制造依赖吗?

每次迭代据此打分——"伴侣感"是可验收的,不是口号。

---

## 11. 待决项

- [ ] 向量库具体选型(服务端 Qdrant vs Chroma vs pgvector;端侧 sqlite-vec)——P2 前定。
- [ ] Redis 持久化策略(AOF / 纯缓存可重建)——倾向"纯可重建,真相在 SQLite"。
- [ ] 巩固流水线触发节奏(会话结束 + 每日 + 每 N 轮)。
- [ ] 大脑保活窗口 N 分钟取值;每日主动问候上限。
- [ ] Gemma 4 license 商用核实。
- [ ] 人格/边界的**用户配置项**设计(用户自定义人格、关系深度、是否启用最小危机底线)——体现"用户自治"。

---

## 文档索引
- 本文 = canonical 设计。
- `reference-projects-research-2026-06-18.md` — 外部开源对标(mem0/Letta/Zep/LiveKit/Pipecat/LiteRT-LM…)。
- `reference-code-findings-2026-06-18.md` — 本地参考源码可复用清单(公式/file:line/校正)。
- `superpowers/specs/2026-06-18-embedded-adaptation-design.md` — 适配/接缝推导过程(已并入本文)。
- `chat-a-final-design.md` / `real-time-agent-design.md` / `chat-a-architecture-design.md` — 历史/细节附录(被本文取代,保留备查)。
