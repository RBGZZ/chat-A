# chat-A 统一设计(Canonical v1.0)

> 状态:**canonical**(权威设计)。整合自 `real-time-agent-design.md`(架构骨架)+ `superpowers/specs/2026-06-18-embedded-adaptation-design.md`(适配/接缝)+ `chat-a-final-design.md` v2.1(人格/记忆/语音细节)+ 两份调研(`reference-projects-research-*`、`reference-code-findings-*`)。
> 上述文档自此降级为**细节附录/历史**;本文为唯一权威。冲突以本文为准。
> 日期:2026-06-19 初版;**2026-06-22 大幅增订**——逐个深读 Neuro 生态 / 实时语音 infra(LiveKit·Pipecat)/ OpenTelemetry / 记忆框架(mem0·Letta·OpenMemory·Memoripy),固化:工具协议(§3.3 Anthropic tool-use)、能力侧 MCP 锚定(§3.3/§12 外界交互模块)、Neuro SDK 专有机制暂挂(🅽)、runtime 分层(§4.2 Pipecat 帧管线 + 事件总线 + A/B 事件划分 + 派发语义)、§4 语音算法增量、§5.5/§5.8 记忆打分/写路径、§8.1 OTel 两层追踪。已进入 §9 P0 实现(`packages/protocol` 已落地)。
> 实现细节(公式/file:line)见 `reference-code-findings-2026-06-18.md` 及三份 `*-findings-2026-06-22.md`(见文末文档索引)。

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
│  PC/手机/树莓派    │  (双向)     │  事件总线(A层)/帧管线(B层)/5状态  │
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

### 3.1 模块化原则:支持"模块级大改/整体重写"(开发期硬要求)
> 开发中必然出现**某个功能模块被大幅修改甚至推倒重写**的情况(如换记忆后端、重做打断、替换人格演化)。模块化的目标就是让这种改动**爆炸半径可控**。

- **接口契约稳定,依赖倒置**:每个模块(不止 7 接缝,还包括 `gateway/runtime/cognition/providers` 各包)只暴露**类型化接口**;其它模块**只依赖接口 + `protocol/` 共享类型,绝不 import 另一模块的内部实现**。重写一个模块 = 只要接口不变,消费者零改动。
- **事件解耦**:模块间尽量经 `LightVoiceBus` 事件通信;只要事件契约不变,模块内部随便改。
- **单一真相源**:SQLite 为 system-of-record → 存储层重写(如换向量库)不丢数据、可重建。
- **契约测试**:在每个模块边界写 contract test;重写后用同一套契约测试验收。
- **单一职责 + 小文件**:模块保持聚焦,文件过大=职责过多,应拆分,使"重写"始终可控可读。
- **验收判据**:*改动任一模块,受影响的只有它的接口消费者,且能被枚举*。若一处改动波及不相关模块 → 说明边界没划好,需重新设计接口(而非将就)。

### 3.2 开发原则(P0 起遵循,与 §3.1 模块化、§8.1 可追溯并列)

1. **可测试性:把 LLM 关进笼子 + 确定性可测**
   - 所有 Provider(LLM/STT/TTS/embedder)可 mock;**确定性内核**(记忆打分/PAD/过滤/路由/分句)写 golden test;LLM 走 schema 约束输出 + record-replay fixtures;"伴侣感"用 §10 rubric 做 eval。
   - 是 §3.1 的孪生:**不可测 = 不敢改 = 模块化形同虚设**。能用代码算的(打分/PAD/路由/过滤)绝不交给 LLM;LLM 只在 schema 约束的明确边界调用并校验输出——可测/可追溯/可控/省钱的共同底座。

2. **流式优先 · 快反应优先 · 音频低延迟(实时语音的命门)**
   - 每阶段定延迟预算(首 token / 首音频 TTFA),**流式贯穿全链**;新功能加延迟必须论证;延迟进 trace(§8.1)。延迟一高就"不像人"。
   - **快反应优于完美回答**:宁可先给一个立刻的、可被打断的短反应,也不让用户等一个完整长答。让位"完整长答"给"立刻短答 + 流式续上"——契合伴侣北极星(真人也是边想边说)。
   - 可操作子条款(承 2026-06-25 参考项目调研 `streaming-fast-response-findings-2026-06-25.md`):
     - **首句即合成、绝不等整段**:LLM token 流按句切(首句可逗号切),第一句到齐就喂 TTS 出声。
     - **音色一致靠"同一合成会话内增量喂文本",不靠"整段一次合成"**:逐句在**同一 TTS task/session 内 continue/append**(非每句新建连接)——既流式又不漂移。(⚠️ "同 session 多次 append 不漂移"需真机验证,见 §4。)
     - **生成即目标语种,不事后翻译**:显示≠合成语种时,主回合直接产出目标语种(§4.1),不走串行第二次 LLM 翻译(徒增首音延迟)。
     - **先应后补(filler/backchannel)**:必要时先喷一声语气词掩盖首音延迟。
     - **可打断、半句可回**:流式回复随时可被用户打断,半句也能干净写回记忆。
     - **预热消冷启**:LLM/TTS 连接 eager 预热,避免首次冷启动延迟。
     - **TTFA 进预算与 trace**:首音到达时间设目标(经验起点 p50<800ms,真机 benchmark 校准)、落 trace 可观测。

3. **永不崩、永不哑(优雅降级)**
   - 任一外部依赖(网络/LLM/STT/TTS)失败都降级,**绝不硬崩、绝不无解释沉默**;每个 await 配超时 + 兜底。崩溃/卡死会瞬间击碎"伴侣"幻觉,比答错致命。

4. **行为即配置:Prompt 与参数外置**
   - 阈值/权重/模型/**人格 prompt** 全进 config/文件,杜绝 magic number;**prompt 版本化、可热调**。改人格/行为不该动代码、不该重部署。

5. **数据即关系:长寿数据 + 迁移纪律**
   - schema 带版本 + 迁移脚本;长期积累的记忆/关系/人格**绝不能因 schema 变更丢失**,开发期也要能迁移旧库。"长期伴侣"的价值全在累积数据里。

> 后续待细化(实现期):隐私优先(敏感记忆加密/可导出删除,与 §8.1 trace 的脱敏平衡)、成本与失控防护(每回合成本 metric + dev 防 LLM 死循环烧钱)。

### 3.3 Agent loop / 工具调用契约(接缝 5 细化,借 Neuro 官方 SDK + Open-LLM-VTuber)
> 详见 `neuro-ecosystem-findings-2026-06-22.md` §1。`TurnStrategy` 从"单次流式"演进到 Agent loop 时,工具调用遵循:

> **📌 协议分层决策(2026-06-22 三方对比 MCP / Anthropic 原生 tool-use / Neuro SDK):**
> - **模型侧(`TurnStrategy ↔ Claude`)以 Anthropic 原生 tool-use 为准**:`input_schema` 完整 JSON Schema(+`strict`)、`tool_use`/`tool_result`、原生并行、`input_json_delta` 流式、`tool_choice`。**不自创**;下方"动态枚举 schema 只用最小子集"是对约束解码模型的妥协,Claude 不受此限,可用完整 schema。
> - **✅ 能力提供方侧(外界交互模块 ↔ 外部进程/外设)= 锚定 MCP 为标准协议**(已定稿,见 §12):外部能力进程作为 **MCP server**,大脑作为 MCP client——`initialize`+protocolVersion 协商 / `tools/list`(分页)+`notifications/tools/list_changed`(=动态 register/unregister)/ `tools/call{name,arguments}`+`content[](text/image/audio/resource)`+`isError` / stdio(本地·外设)+Streamable HTTP(远端·合体)双传输。**取代此前自创的 HELLO/PUSH 握手**。MCP 工具在边界**适配成 Anthropic tool 定义**喂模型(`mcp_server.tool` 命名空间防同名覆盖);Claude 原生 MCP connector + SDK 的 MCP→tool 转换器使两层无缝。
> - **🅽 Neuro SDK 专有机制 = 暂不纳入,标记待后续**:`actions/force`+priority(主动注入)、阻塞式 `result`+单飞行重试、`context(silent)` 世界事件通道、撤销宽限期(`_dyingActions`)。这些 MCP/Anthropic 都没有,但**当前用不上**——等做到"在世界里主动行动 / 陪玩游戏"时,再考虑如何作为 chat-A 自有运行时层叠加。下方标 🅽 的条目即属此类。

- **三段式 `validate → 回发 result → execute`,结果先于副作用**:参数一合法就把结果回灌 LLM 让它继续说话,副作用 execute 异步在后;`validate(args)` 是纯函数(满足可测试性),校验失败不产生副作用、可安全重试。
- **能力驱动 + 运行时降级到 prompt 模式**:Provider 带 `support_tools` 能力标志;原生 tool-use 失败→切 prompt 注入工具定义 + **括号配平流式 JSON 检测器**抠出调用。树莓派本地模型必备(本地/廉价模型常谎报工具支持,需按 modelKey 缓存能力标志)。
- **动态枚举 schema**:工具参数 schema 每回合按真实状态生成(当前歌单/真实记忆标签),把约束前移进 schema,省"报错—重试"往返;schema 只用最小子集(type/enum/required/properties)。
- **动态 register/unregister**:工具集随情境实时增删——用 MCP 的 `tools/list` + `notifications/tools/list_changed` 实现(标准化,见 §12)。🅽**撤销宽限期(`_dyingActions`,刚下线工具仍可调时返回专属语义)= 暂不纳入,待后续**。
- 🅽 **force + priority = 主动性载体(暂不纳入,待后续)**:autonomy 主动注入 forced turn("现在该主动开话题/表达反对")、priority 抢占、阻塞式 result + 单飞行重试集中一处——Neuro SDK 专有,当前用不上,做主动行动/陪玩时再叠加。
- **错误归因**:工具结果带 `fault: system|tool|user-input`,LLM 不把系统故障道歉成"我错了",trace 自带归因。

---

## 4. 语音管线与无条件打断(承 v2.1,简述)

- **双路径**:优先多模态 audio-in Provider;失败/超预算降级到 STT+LLM+情感补丁。
- **三层各司其职**:VAD(有没有声)/ `TurnDetector`(说完没,该接话)/ generation 计数(被插嘴→打断)。
- **跨网络无条件打断**:中断体感动作留终端本地(立即 flush,0 网络延迟);算力回收交网络异步;**每帧带 generation 标签**,终端丢弃不匹配的迟到帧。
- **流式 3 层过滤**:LLM delta → 剥工具调用/表情标签/舞台指示 → 分流出 显示文本 / 口语文本(→TTS) / 情绪标签(→人格)。
- 实现参考:`reference-code-findings` §1(voice-core 打断,用 `AbortController`;EchoGuard 必须真启用 + barge-in 连续 N 帧去抖)、§2/§3(Nexus 帧管线 + realtime-demo WebSocket)。

**🆕 打断/延迟工程细化(Neuro 生态深读,详见 `neuro-ecosystem-findings-2026-06-22.md` §2):**
- **打断 = abort 三件套**:per-stage `request/finished` **握手**+逐阶段超时(确保下一回合启动前上一回合资源真清干净)、`abort_block_event` **闸门**(abort 进行中冻结新回合启动,杜绝新旧状态交叠)、请求队列 **drain 只取最新**。generation 标签管"已发出旧结果作废",这三件管"还没开始的旧回合别启动 + 同步清场"。
- **Intent 优先级抢占统一打断**:每段输出=带 `behavior:queue|interrupt|replace`+`priority` 的 intent,用户开口=critical 抢占 normal;**一个 AbortSignal 串起 LLM/TTS/播放**,打断零残留。
- **双向打断闭环**:据"客户端真在播"才算打断;打断=服务端 abort 生成 **且** 客户端立即排空已缓冲音频(否则已下发音频仍播完)。
- **降感知延迟**:乱序生成/顺序播放(seq 重排)、TTS chunker 前 N 句 boost、**自校准延迟预算**(实测 TTFT/TTFA → `silenceTimeout=max(modelPause, measured+overhead)`)、**partial 抖动相似度门控**(末尾词≥0.95 不自打断)、"hot" 预测性抢跑、首段自适应 jitter buffer。
- **优雅降级语义**:STT 失败区分"取消 vs 真异常"(后者停喂音频+走降级)、音频背压丢帧+计数,不无限堆积、不静默卡死。

**🆕 实时语音 infra 深读增量(LiveKit Agents / Pipecat,详见 `voice-infra-findings-2026-06-22.md`;帧管线骨架决策见 §4.2):**
- **预测性生成(preemptive generation)**:STT interim/final 一变就**先跑 LLM 不出声**、缓存快照;轮次确认后比对**输入指纹**(transcript+ctx+tools `is_equivalent`)——命中直接复用(吃掉 LLM 首字延迟),未命中 abort 重跑。护栏必带:`max_retries=3` / `max_speech_duration=10s` / 默认只投机 LLM 不投机 TTS(防抖动期烧 token)。这是"误打断减少"之外的**另一半延迟红利**。
- **EOU 概率驱动动态 endpointing**(= 上文"自校准延迟预算"的具体算法):EOU 模型 `prob<阈值`(用户没说完)→ 把静音窗从 `min_delay` 拉到 `max_delay`;`DynamicEndpointing` 用两个 EMA(α=0.9)分别学句内/轮间停顿。纯 CPU,本地 mini ONNX 可跑(树莓派友好)。
- **先 pause 后定夺打断 + 半句写回上下文**:打断时**先 `pause()` 不销毁** → 起 `false_interruption_timeout≈2s` → 确认真打断才丢、否则 `resume()`;`backchannel_boundary` 起止冷却抑制附和;**被打断的半句 assistant 文本写回记忆(标 `interrupted`)**——伴侣"我刚说到一半"的连贯性(§5 写路径同此意)。
- **10ms 音频切片 + wall-clock 配速**(播放中途干净打断的物理前提,16k mono=320B/片);**TTS 打断 = 关流式 context 而非断连**(低延迟,无 word-timestamp 的服务才整连重连)。
- **⚠️ 裸 WebSocket 缺口(LiveKit 靠 WebRTC/云推理白嫖,chat-A 必须自建)**:逐帧时间戳/采样率(EOU/打断时间对齐)、**AEC 或 agent 说话时门控 STT**(防自打断,树莓派关键)、客户端**播放游标回传**(打断后对齐"实际播到哪")、附和/打断分类**无开源本地模型**(初期用 VAD+min_words+min_duration+backchannel_boundary 启发式降级)。

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
  - **qwen-tts-realtime 落地(已据官方核实 2026-06-24)**:`output_lang`(ISO 码)在合成边界映成 Qwen `language_type` 名(`Chinese/English/…`,首字母大写英文名,**非** `zh`/`en` code)下发;未配置 → 不发该字段 = 服务端 `Auto`(逐字回归)。
  - **声音复刻一致性纪律**:千问声音复刻创建时的 `target_model` 必须与后续**合成时的 model 逐字一致**(含日期快照),否则合成失败——音色绑单模型;装配层据合成配置选 target_model 保证同串。
  - **CosyVoice 复刻语种机制相反(备注,暂不实现)**:CosyVoice 在**注册期**用 `language_hints` 声明音色语种、**合成期无**语种参数、语种**焊死在音色**上;且管理动词为 `list_voice`/`delete_voice`、字段为 `voice_id`。Factory 将来接 CosyVoice 复刻时**别套用** qwen 的「合成期发 `language_type`」思路——两套契约不可混。
- **能力驱动路由**:STT/TTS Provider 声明 `languages` 能力,网关按 input/output 语种选可用 Provider(接缝 2);多模态 audio-in 路径同理需支持跨语种。
- **直接参考**:realtime-demo 的 talk/translate 模式 + `source/target` 语种 + `system_prompt_for(mode,source,target)`(`reference-code-findings` §3)。
- 运行时可热调(配置热加载)。

### 4.2 runtime 分层架构:帧管线(管 runtime 内)+ 事件总线(管跨模块)
> 决策(2026-06-22,深读 Pipecat / LiveKit Agents 后,详见 `voice-infra-findings-2026-06-22.md`):**采用 Pipecat 式帧管线作为 runtime 内部的流式数据流骨架**;它**取代**早期 Nexus 帧管线构想(同范式、更成熟)。但帧管线**只管一层**,与模块总线、回合调度分工明确:

```
A 模块事件总线(LightVoiceBus + AIRI traceId)   ← 跨模块/接缝,粗粒度;cognition/providers 只见总线事件,不见帧内部
        │
C 回合调度(AIRI 单消费者优先级队列 + LiveKit 授权闸门)  ← 决定"跑哪个回合"(用户语音 URGENT vs autonomy)
        │
B 帧管线(Pipecat 四态帧 + 双队列)  ← 执行"一个回合"的 STT→LLM→分类→TTS→播放
   └ 处理器(FrameProcessor)= OLLV 装饰器(3 层过滤)/ SentenceAggregator / TTS chunker
   └ 打断 = InterruptionFrame 广播 + Uninterruptible 选择性保活 + abort 三件套
        │
E 取消原语(AbortSignal + 跨网络 generation 标签)贯穿 B
```

- **B 帧管线(runtime 内)**:`SystemFrame`(插队、不受打断)/ `DataFrame`/`ControlFrame`(排队、打断丢弃)/ `UninterruptibleFrame` mixin(打断也送达,如结束信令、函数结果);每 processor **双队列双任务**(System 立即处理,Data/Control 排队);`InterruptionFrame` 双向广播 + 队列 reset。3 层过滤 = 一个 `ClassifierProcessor`。音频出站 **10ms 切片 + wall-clock 配速**(中途干净打断的物理前提)。
- **A 模块总线(跨模块)= 边界**:`gateway/cognition/providers` 等接缝之间只走**粗粒度模块事件**(带 correlationId,经 OTel AsyncLocalStorage 自动传 traceId),**绝不暴露帧内部**——保 §3.1"模块可整体重写"。gateway 在边界把 WS 入站消息翻译成总线事件 / 帧。
- **C 回合调度**:用户语音永远 URGENT(§7 软反转)、coalesce 丢陈旧自言自语、no-action 预算、出声前授权闸门(用户静音才让 agent 开口)。
- ⚠️ 避开 Neuro `Signals` 全局可变状态 + setter 副作用(与可追溯冲突)。

#### 4.2.1 A 层 `BusEvent` vs B 层 `Frame`(类型层就挡住串层)
- **A 层 `BusEvent`(`protocol/bus-events`,跨模块、粗粒度、低频)**:`turn:start/end`、`vad:speech_start/end`、`stt:final`、`tts:first_audio`、`turn:interrupt`、`provider:failover`。走 LightVoiceBus,`deepFreeze` + history + traceId。
- **B 层 `Frame`(`runtime` 帧管线内,高频流式)**:音频帧、`stt:partial`、`llm:token`、`tts:chunk` 等——**不上总线**(高频 + deepFreeze 成本 + 破坏分层)。音频帧跨终端↔大脑走 `AudioTransport`(接缝 1),也非总线事件。
- 二者在 `protocol` 里是**两套类型**,编译期防止把 `audio:chunk` 误 emit 到模块总线。

#### 4.2.2 LightVoiceBus 派发语义(建造前定稿,2026-06-22,参考 AIRI/Nexus/Pipecat/LiveKit/Zerolan)
1. **直接类型化 pub/sub + `deepFreeze` + 每订阅者 try/catch**(借 AIRI),**不采用 Nexus effects-reducer**:副作用可测性靠"handler 注入 port"(§3.1 依赖倒置);可重放靠 SQLite 决策 trace(§8.1),不靠总线 effect 重放。effects-as-data 仅"需确定性重放副作用"时后续可选。
2. **emit 同步有序分发**;async handler **fire-and-forget**(不 await,避免串行加延迟)但包裹捕获 rejection + per-handler 超时只告警不杀 + 经 AsyncLocalStorage 传 traceId;**A 层总线不设队列**——粗粒度低频,背压/有界缓冲是 B 层帧管线的事。JS 单线程 + 同步 emit → 同 correlationId 天然有序。
3. **总线不每 emit 建 OTel span**(太多);span 在 turn/service 边界由编排器建(借 LiveKit/Pipecat);`onAny` 全量经一个 **observer(借 Pipecat observer)落 SQLite event 日志**(带 correlationId + 当前 trace_id/span_id),即 §8.1 三层日志的 `event` 层。

> §4 的打断/延迟工程增量(预测性生成、EOU 概率驱动动态 endpointing、先 pause 后定夺打断 + 半句写回上下文、TTS 关 context 而非断连等)见 `voice-infra-findings-2026-06-22.md`,落在 B/C 层。

### 4.3 语音 Provider 可换性 = 嵌入式硬约束(2026-06-23 参考代码调研)
> 依据 `embedded-lightweight-findings-2026-06-23.md`(精读 8 个参考项目簇)。视角:**PC 优先开发,但为嵌入式预留轻量化后路,且后路绝不能被 day-1 决策堵死。**

- **🚨 TTS 是嵌入式真正的瓶颈(不是 LLM)**:LLM 可量化/可回源,但 CoquiTTS/GPT-SoVITS 无 ARM 优化。可行的嵌入式 TTS 仅 **Kokoro ONNX(~100MB 本地,projectBEA 验证)+ Edge-TTS(云,免费流式,Nexus 默认)**。→ **STT/TTS/LLM/Embedder 必须从 day 1 做成可换 Provider(接缝 2),核心层禁止引入无 ARM 路径的硬依赖**(CoquiTTS 这类只能作 PC 可选 Provider)。
- **最高优先接缝 = Factory + discriminated-union 配置**(抄 Open-LLM-VTuber):五类后端(STT/TTS/LLM/Embedder/人格)全走 `create_X(config)` + 判别联合配置,**零代码切换、无 if/else 散落、无重启**。这是"PC↔嵌入式分档"的物理基础,后补代价极大。Embedder 接缝见 §5.7。
- **profile gate `--target pc|raspberry|browser`**:档间差异**全在配置 + Factory 选择**,代码零分叉(承 §5.6)。即使当前只实现 pc 档,接缝先留好 `device(cpu/cuda)`/`compute_type(int8/float16)` 字段。
- **能力门 fail-fast + 优雅降级**:Provider 声明 `support_tools`/`support_streaming`/`requires_cuda`,**加载前检查能力**(不是失败后回退,避免状态歧义);ASR 失败→纯文本输入,TTS 失败→只显示文本无音频(参考项目普遍缺此降级,chat-A 须补,承 §3.2)。
- **延迟阈值全自校准、不写死**(LiveKit 范式,承 §4 自校准延迟预算):PC/Pi 同代码自适配。
- 其余可借鉴(流式 TTS chunker 降 TTFA / CJK 用 grapheme count / failover orchestrator + 成本闸门 / idle 状态机两档同代码 / bullet-list 上下文省 KV)详见调研文档,落 B/C 层与 §5.4。

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

- **schema 要点**:`people(person_id, name, is_primary, relationship_state, voiceprint_ref, status: primary|member|guest, added_by: user|agent)`;记忆/关系都挂 `person_id`。**现在只填主用户,但结构已支持用户组与自主纳入,免未来重构。** `relationship_state` 为 JSON,**首字段 = `closeness`(关系亲密度,见 §6.1b)**;日后可扩多维(trust/familiarity/affection),JSON 天然支持、免迁移。
- 说话人识别走大脑侧(声纹模型/diarization),适配 B 架构(终端只送音频);Provider 能力 `speaker_id`。
- 区别于 deferred 的**多租户**(多个互相独立的主用户、各自一套伴侣)——那仍是后续大版本。这里是**一个伴侣、一个主用户、可认识多人**。

### 5.4 分两档注入(核心常驻 + 外围语义召回)
| 档 | 内容 | 注入 |
|----|------|------|
| **核心**(Hot/pinned,永不衰减) | 用户:名字/过敏等;Agent:名字/core_belief/根本设定 | **每轮必注入** |
| **外围**(语义召回) | 用户长期记忆;Agent 背景故事细节/说过的话 | **按相关性语义召回** |

> 这把"人格背景故事"从"塞满 prompt"改为"**RAG-over-persona**"——既连贯又不撑爆 context,正是陪伴类生产标准(memory-driven persona)。

> **🆕 prompt 组装 = 优先级 Injection 接缝**(借 Neuro,详见 `neuro-ecosystem-findings-2026-06-22.md` §4):人格(OCEAN)/情绪(PAD)/记忆 RAG/时间情境/未了话题**各做成一个 `PromptContributor`**,返回 `{text, priority}`,按 priority 升序拼接(高优先级靠近末尾=最近注意力),拼到 ~90% context 预算就从最旧历史裁剪,拼完各自 `cleanup()` 清一次性状态。**杜绝硬编码巨型模板**,契合接缝化+人格用户自定义+行为即配置。
> **🆕 KV-cache 稳定性规则**:系统提示+人格前缀**字节级稳定**供 KV 复用;volatile 上下文(id/时间戳)只以扁平 `[Context]\n- id: text` bullet **追加到最后一条用户消息**;弱模型(8B/14B)**别用 `<context>` XML 标签**(会被回吐);时间用每消息 `[HH:MM]` 前缀+系统提示日期锚点。直接服务树莓派延迟预算。

### 5.5 混合召回(每回合)
`score = 语义(向量,真 embedding) + 关键词(SQLite FTS) + 情感共振(PAD 匹配重排) + 时间衰减 + 重要性`
- **语义**:真 embedding(接缝 7),做"主题相关/联想"。
- **情感共振**:Russell 2D VA 投影 + empathy/repair/reinforce 三模式 + priming(公式见 `reference-code-findings` §F)。
- **衰减**:统一 `0.5^(days/H)`(H 默认 30),pinned 免衰,召回 +0.15 封顶 1.5,惰性 SQL 实时算。**🆕 增强(OpenMemory `decay.py:152-154`,见 `memory-frameworks-findings-2026-06-22.md`):让 H 随 salience/热度变**——重要/常访问记忆衰减更慢(`salience` 进分母、按 hot/warm/cold 分层),但**保持单一权威公式 + 惰性实时算、不写回**(避开 OpenMemory 两套公式漂移 + Memoripy 复利写回的坑)。
- **🆕 上下文窗口拼接**:召回命中后额外取其**前后各 N 条**拼成连贯片段注入(连贯回忆 vs 零散句),详见 `neuro-ecosystem-findings-2026-06-22.md` §4。
- **🆕 Reflection 巩固**:巩固/夜间沉淀时让 LLM 把一段对话蒸馏成"最显著的几条高层 Q&A"存回向量库(P1 即可作 3 层记忆雏形);会话结束**异步**生成 + 幂等去重(`diary_{sessionId}` 存在性检查)。借 OpenMemory `reflect.py` 的"聚类→共识→提升源 salience"结构(但用 LLM 蒸馏替其纯模板拼接)。
- **🆕 schema 评分列 + 多宽向量列**:记忆表带 `importance / emotional_impact / access_count / last_accessed` 评分列;预留**多宽度向量列**(如 1536/1024/768)按 `EMBEDDING_DIMENSION` 选列 → 换 embedder 不改 schema(强化接缝 7)。
- **🆕 打分归一(mem0 `scoring.py:31-119`,见 `memory-frameworks-findings`)**:关键词分(FTS5 `bm25()` 无界)过**查询长度自适应 sigmoid** `1/(1+exp(-s·(raw-m)))` 压到 [0,1];混合用**自适应分母** `min(Σsignals/max_possible,1)`——某路信号缺席时分母自动缩小(**无 PAD/无关键词时不被稀释**)。⚠️ 但门控只对"无任何信号"生效,**情感共振/关键词单独能把项拉进候选池**(别学 mem0 语义门控硬丢低分项,会丢"语义不相关但情感强共振"的记忆)。
- **🆕 检索即强化 + 情感共振矩阵**:命中即升 `importance`(OpenMemory `sal+=0.18·(1-sal)` 或 Memoripy 乘性 `×1.1命中/×0.9未命中`),并沿关联图轻传播到邻居("被联想到→记得牢");"情感共振"可落成 **5×5 跨扇区常量矩阵**(emotional↔episodic=0.7、↔semantic=0.4,O(1) 查表)+ `boosted_sim=1-exp(-3·sim)` 放大中段区分度。
- **🔴 非阻塞召回(硬约束,2026-06-23 用户指令:记忆检索绝不阻塞系统、必须保证快速响应)**——回合首字延迟(TTFT)绝不被记忆检索焊死:
  - **快路径永远可用且非阻塞**:关键词(FTS)+ 联想扩散 + 归一打分走同步 SQLite(`DatabaseSync`),亚毫秒~几毫秒,**永远先返回**;它是召回的下限,任何上层增强失败/超时都退回它(§3.2)。
  - **语义检索异步、且移出关键路径**:query embedding 是**异步**(网络/本地推理,几十~几百 ms)——**绝不在同步 `recall()` 内联**(现 `recall()` 同步签名只为关键词期;语义期必须显式开 async 召回缝)。query 向量在**调 recall 之前异步算好**或经 `recallSemantic()` 异步获取。
  - **用预测性生成隐藏往返**(§4):STT interim 一出就并行起跑 embedding/语义召回,与"用户还在说"重叠;query 向量缓存复用;**延迟吃紧时直接跳过语义、只用快路径(优雅降级)**,绝不让首字等语义。
  - **向量 KNN 不卡事件循环**:sqlite-vec 暴力 KNN 是同步、会占用单线程(1 万×1024 维 ~75ms 会拖住音频管线)——**候选集封顶 + 量小直接暴力**;规模增长再考虑 worker 线程 / LanceDB(§5.6 接缝已留)。
  - **写侧 embedding 走后台**:新记忆向量化在回合收尾之后异步写(§5.2),不挡热路径。
  > 这条是 c2(embedder 接召回)串行切片的**前置约束**:接线方案必须先满足"快路径非阻塞 + 语义异步旁路 + 可降级",否则不得接入。

### 5.6 部署 profile(同一接口,不同后端;2026-06-23 按 §11 决议收敛为单轨)
> **范围澄清(§11 决策)**:项目**只面向单机/单主用户,不考虑多用户高并发**。因此存储**单轨化**——**不上 Redis、不上专用向量库(Qdrant/Chroma/pgvector)、不做多租户**。两档 profile 的差异**不在存储后端**(都是 SQLite + sqlite-vec),而在 §5.9 所说的"**认知加工的厚度**"与 embedder/量化档位。

| Profile | 工作层 | 中期/真相源 | 长期/向量 | 适用 |
|---------|--------|------------|-----------|------|
| **Lite(嵌入式,默认)** | SQLite 内存表/进程内 | SQLite | **sqlite-vec**(暴力 KNN;量小够用) | Pi/手机/单机本地大脑 |
| **Perf(PC/服务端)** | SQLite 内存表/进程内 | SQLite | **sqlite-vec**(超 ~10 万条 → 平替 **LanceDB IVF_PQ**) | PC;**多出的算力优先投认知层(§5.9),非检索后端** |

> 认知**分层是逻辑概念,物理后端统一**(SQLite 真相源 + sqlite-vec 派生索引,§5.2)——既保住嵌入式可行性,又避免单机项目背上分布式组件的复杂度。
> **接缝预留**:"向量存取"做成接缝(承接缝 7),`sqlite-vec → LanceDB` 在记忆量逼近 ~10 万 或弱 CPU(Pi 4)超延迟预算时**平替**,召回逻辑不动。Redis/专用向量库仅作**未来真有横向扩展需求**时的可选项,当前不引入。

> **🆕 轻量化接缝清单(2026-06-23 参考代码调研,详见 `embedded-lightweight-findings-2026-06-23.md`)**——"现在埋零成本、后补堵死后路"的接缝,贯穿 §4.3/§5.7:
> - **现在埋**:① 五类后端 **Factory + discriminated-union**(最高优先,§4.3)② profile gate `--target`(留 device/compute_type 字段)③ 能力门 fail-fast + STT/TTS 降级链 ④ generation 标签贯穿(承 §4/§8.1)⑤ 记忆向量 **BLOB 不透明存储**(换 embedder 后台 re-embed 写回同列,免 schema 迁移)⑥ 人格情绪**纯本地确定性**(LLM 情感评估仅可选增强,已落地)。
> - **以后填**:Pi 量化 runbook(Llama.cpp GGUF + Kokoro ONNX + Sherpa-ONNX,目标 ~1.2GB 纯 CPU)、idle 状态机低功耗档、failover orchestrator + 成本闸门。
> - **避开**:无条件引 transformers/ChromaDB/Milvus、硬编码后端、毫秒级衰减写回、全表余弦无上限、agentic 记忆操作(均见调研反模式表)。
> - ⚠️ **所有 Pi 延迟数字均为估算,需真实树莓派实测后再定阈值**。

### 5.7 Embedder(接缝 7)
- 默认 **BGE-M3**(BAAI,中文标杆,dense+sparse 天然混合,8192 ctx,大脑在 PC/服务端跑无压力)。
- 端侧合体:**Qwen3-Embedding-0.6B**(ONNX int8)。云端 API 可选(质量最高、成本~$0.02/1M)。Hash 仅离线兜底。
- 换模型 = 改 config + 重建向量索引(因向量库是派生,可重建),召回逻辑不动。

#### 5.7b c2 接线方案:embedder → 召回(非阻塞,2026-06-23 定稿)
> 承 §5.5「🔴 非阻塞召回硬约束」。核心:**memory 保持同步且不依赖 embedder;query embedding 的异步在编排层(runtime),算好向量再传进同步召回。** 已锁定工程取舍:向量存储 = **Float32 BLOB + JS 暴力 cosine**(不赌 sqlite-vec 在 ARM 的原生扩展,做成接缝日后平替 LanceDB/sqlite-vec);`queryEmbedBudgetMs` 默认 120(支持 0=只用缓存绝不等);候选封顶默认 1000;关键词+向量用**加权归一融合**(参考共识,见下「调研裁决」),`fusionMode` 默认 `weighted`、`rrf` 留作可选备选。

- **memory 侧(c2a,纯包内)**:① 向量列 `embedding BLOB`(不透明存储,schema v7→v8)② 同步 `recallByVector(vec)` JS 暴力 cosine ③ 同步 `recallHybrid(query, {queryVector?})`——有向量则 **向量相似度作一路 min-max 归一信号、折进既有加性打分**(同关键词/情感/衰减/重要性一套加性归一,slice ③ 已落地;`fusionMode:'weighted'` 默认,`'rrf'` 备选),再接联想/kind;**无向量 == 现有 `recall()`(快路径)** ④ `setEmbedding(id,vec)` / `addMemory` 返回 id / `memoriesNeedingEmbedding()` 供后台补嵌。**全部同步,不 import embedder。**
- **runtime 侧(c2b,焦点串行)**:注入 `embedder?`(缺省=关语义=与今天逐字一致)。turn 流程利用**已有的 `detectStance` await 做并行重叠**:
  ```
  mood = persona.tone()
  embedP = embedder ? embedQueryBudgeted(userText) : null   // 异步起跑,带 LRU 缓存 + 超时预算
  stance = await detectStance(...)                           // 已 async,免费重叠 embed
  queryVector = embedP ? await embedP : null                 // 有界等待;超时/失败/关 → null
  composeSystem(..., queryVector) → memory.recallHybrid(userText, {queryVector})  // null 即退回快路径
  ```
  - `embedQueryBudgeted`:查缓存→未命中 `embedder.embed([text], signal)` + `AbortController` + 超时;超时/报错→`null`(退快路径)且后台跑完写缓存;**绝不抛进回合**。首字前最坏额外延迟 = `max(0, budget − stance耗时)`。
- **写侧 embedding**:`finalizeTurn` 回复后,新记忆向量化走**后台 fire-and-forget**(embed→`setEmbedding`),失败仅告警(承 §5.2"异步写向量索引")。
- **预热钩子(P2 语音预留)**:`prewarmRecall(partialText)` 在 STT interim 提前算 query 向量入缓存 → turn 时缓存命中、往返全隐藏(§4 预测性生成);文字 MVP 先 no-op,接缝就位。
- **降级链**:embedder 缺省/超时/报错/KNN 空 → 关键词快路径(与今天一致),逐层不抛(§3.2)。
- **可观测(§8.1)**:决策 trace 增 `semanticUsed/embedLatencyMs/embedTimedOut/cacheHit/vectorHits`,上线后回放确认"语义没焊进首字"。
- **切片顺序**:c2a(memory,可 worktree)→ c2b(runtime,焦点串行)。

> **🆕 调研裁决(2026-06-23,参考项目语义检索/向量库专题精读)**——锁定取舍获代码级印证,两点修正:
> - **✅ 印证**:BLOB+JS 暴力 cosine(OpenMemory `vector_store.py:40,67-89` 几乎一比一、Nexus、memoripy 选 `IndexFlatL2`=精确全扫,三家独立)/ 不赌 sqlite-vec(端侧无人用 ANN,ANN 全是服务器级 Milvus/Qdrant/pgvector/Chroma)/ Hash 兜底(Nexus `local-hash-v1` 本就是默认)/ 端侧无 rerank(仅 mem0 云 platform 才上)。
> - **🔧 修正 1:融合用加权归一,非 RRF**——所有参考项目用「各源 max/min-max 归一 + 加权和」(Nexus `vec×0.7+kw×0.3` 再加性叠 recency/emotion/decay),**无人用 RRF**;且 chat-A 既有 min-max 归一+加性框架,折入向量信号比 bolt 独立 RRF 阶段更一致。→ `fusionMode` 默认 `weighted`,RRF 留备选开关。
> - **🔧 修正 2:维度成本**——BGE-M3/Qwen3-0.6B 是 1024维,比参考本地档(384维)重 ~2.7×,端侧暴力扫描需实测 Pi;**预留"降维(MRL 截断)/换 384维小模型"端侧开关**。
> - **并入轻量技巧**:① **worker 线程跑 cosine**(Nexus)把 O(n×dim) 剥离主线程——直接服务非阻塞硬约束;② embedding LRU 缓存(`model::text`);③ **融合前 over-fetch、融合后才封顶**;④ 召回即强化**串行队列后台写回 + catch**(比 memoripy 同步毫秒写回健壮);⑤ BLOB 字节数反推维度(`len//4`)换模型免迁移;⑥ 中文若 FTS5 分词不足,Nexus 纯 JS CJK-aware BM25 是备选。
> - **反模式**:eros_ai LLM-as-retriever(每次召回喂全部冷记忆给 LLM)——延迟/token 灾难,明确避开。

### 5.8 写路径决策 + 记忆框架深读纪律(2026-06-22,mem0/Letta/OpenMemory/Memoripy)
> 详见 `memory-frameworks-findings-2026-06-22.md`(含 round-1 调研的头条订正)。

- **🆕 写路径分两段**(借鉴 mem0 v2.0.7 的教训:它**已废弃 LLM 决定 ADD/UPDATE/DELETE/NOOP**,退回 ADD-only,因 LLM 误删率高):
  - **热路径 = ADD + 去重**:新记忆先落 SQLite(§5.2),写入即做 **SimHash/MD5 去重**(汉明距≤阈值视重复 → 强化既有记忆 `importance` 而非新建,防长期膨胀)。**热路径绝不让 LLM 内联决定 update/delete**(误删风险 + 延迟)。
  - **离线调和 = 双 Pass diff(§5.1)**:`update/delete/discard` 的矛盾消解**只在周期性/夜间巩固**做(低延迟预算 + 可回放,承 §3.2/§8.1);对旧记忆对标时**用临时整数 ID 而非真 UUID**喂 LLM(mem0 `main.py:815-820` 抗幻觉),回映后落库;delete 保守(宁可标记衰减/discard,不轻易物理删——长期伴侣的价值在累积)。
- **⛔ 明确避开**:
  - **Letta 式 agentic 工具调用自管记忆**(每次读写都 LLM 推理+工具往返)——对实时语音致命;chat-A 确定性打分管线是对的,勿退回(Letta 自己也把整理移到 sleep-time 后台)。
  - **前台同步摘要/巩固**(Letta 在 step 内触发会阻塞响应)→ chat-A 巩固/压缩**全部后台**。
  - **SQLite 全表扫描余弦**(OpenMemory 无 ANN)→ 用专用向量库(接缝 7),SQLite 只做真相源 + FTS + 元数据/衰减字段。
  - **多套不一致衰减/打分公式漂移**(OpenMemory 后台 vs 检索两套)→ chat-A **单一权威公式**(承 §3.2 行为即配置)。

### 5.9 认知保真优先(模拟人类记忆的根本取舍,2026-06-23)
> 综合"主流记忆系统语义检索"四路调研(Generative Agents / A-MEM / Nemori / Mood-Congruent Memory / Letta / Zep,见 round-2 调研结论)定的**统领性原则**。它**反过来约束 §5.5 召回与 §5.6 profile**——凡两者取舍有冲突,以本节为准。

**核心判据:两条正交的轴,chat-A 要的是第二条。**
- **IR 精确度轴**(cross-encoder 精排、穷尽召回、严格 MMR 去冗)——越高越像**搜索引擎**:超人精确、零遗忘、永远调出最相关条目。
- **认知保真度轴**(多线索加权、联想扩散、情绪偏置、惊奇编码、遗忘巩固)——越高越像**人**。
> **结论**:伴侣记忆(北极星 §0)的"人味"来自记忆的"缺陷"(联想、情绪偏置、遗忘、重构),**不来自检索精度**。一套 RRF+cross-encoder+穷尽召回造出的是完美图书管理员,恰恰最不像人。**认知层 ≫ IR 精排层。**

**人类记忆特征 → 机制映射(指导落地优先级)**:

| 人类特征 | 机制 | 参考 | chat-A 现状 |
|---|---|---|---|
| 多线索加权(非相似度 top-k) | relevance+recency+情绪显著性+importance,各 **min-max 归一**后混合 | Generative Agents 三信号 | §5.5 有公式,**缺显式同尺度归一** |
| 联想/扩散激活 | 实体邻接 1–2 跳扩展、记忆链接网 | A-MEM、Zep node-distance | 花名册有雏形,**未做扩散** |
| 情绪一致性回忆 | PAD 匹配做**软重排,非硬过滤** | Mood-Congruent Memory | §5.5 情感共振已有 ✅ |
| 惊奇驱动编码(只牢记预料之外) | predict-calibrate,只存 prediction gap | Nemori | 现用 SimHash 去重(更机械),**待升级** |
| 遗忘是特性 | 衰减 + 检索强化("用进废退") | 艾宾浩斯 / GA recency 刷新 | §5.5 已有 ✅ |
| 情景 vs 语义分层 | episodic(叙事)/semantic(蒸馏事实)显式分层 | Tulving、Letta 分层 | §5.1 部分,**未显式分层** |
| 睡眠巩固 | 夜间事件分割 + 反思,事件→要点 | Nemori + GA Reflection | §5.5 Reflection 已规划 ✅ |

**当前四个缺口(按"补人味"优先级,端/PC 都做)**:
1. **联想扩散**(最该补、又最便宜):A-MEM 式实体邻接表 + 1–2 跳,端侧 SQLite 即可扛。人类回忆是网状勾连,不是孤立检索。
2. **惊奇门控编码**:夜间巩固用 predict-calibrate 替/补 SimHash——"只记住预料之外的,睡一觉把细节蒸成要点"。
3. **三信号显式 min-max 归一**:把 §5.5 的混合分各路归一到同尺度再加权(否则量纲不可比、权重失真)。
4. **情景/语义显式分层**:§5.1 三层的 episodic 叙事 vs semantic 蒸馏事实落到 schema/检索层。

**对 IR 精排的明确立场**:
- **cross-encoder 精排 / 穷尽召回 / 严格 MMR = IR 轴增强,非人味增强**。端侧砍掉不只是省算力,**方向上也对**(人不会每次精准调出最相关那条)。
- 因此**重新解读 §5.6 的"PC 更高性能"**:PC 多出的算力**优先投"更厚的认知层"**(更频繁/更深的夜间巩固、更大模型做惊奇评估与反思、更长的联想扩散跳数、更细的情景叙事生成),**而非投 cross-encoder 把检索做得更准**。cross-encoder 仅作 PC 可选项,且认知它属"搜索引擎方向"。
- **关键词+向量的混合检索保留**——仅作"相关性"这**一路线索**的供给,不是为了拉高精度。⚠️ **融合实现按参考共识用加权归一**(向量作一路 min-max 归一信号折进既有加性框架),非学界常推的 RRF——见 §5.7b 调研裁决(RRF 留作 `fusionMode` 备选)。

**必须钉死的边界(区分"设计的遗忘" vs "不想要的失真")**:
- **lite 档弱 embedder(bge-small)的退化 ≠ 人味**——那是噪声,别美化成"像人健忘"。
- **核心事实绝不参与人类式遗忘**:用户名字/过敏、安全/危机信息(§ 法律底线"救命不可配")——**core/pinned 永久豁免衰减、豁免情绪过滤、豁免惊奇门控**(承 §5.4 核心档)。人会忘小事,但伴侣不该"忘了你对花生过敏"。

### 5.10 簇B/C 设计决议（2026-06-23,承 `github-learnings-2026-06-23.md`）
> 簇A(行为/人格)已实现。本节定簇B(记忆算法升级)、簇C(端侧/工程)的设计;标注**【实现中】/【设计记录·待依赖】**。

**B1 — 联想扩散升级为 PPR(HippoRAG 式)【实现中】**:现有 `#spread()` 是固定 1–2 跳 BFS(sqlite-store.ts);升级为 **Personalized PageRank 随机游走** `r=(1−α)·M·r+α·s`(α≈0.15,~十几次迭代),`M` = 现有无向邻接边(共现权重)行归一,种子 `s` = query 命中的一阶记忆。产出"按 PPR 稳态分加权衰减的多跳联想",比固定跳更像人类联想且自然处理多跳衰减。**复用已有邻接表 + recallByVector 近邻**(可作额外软边),不引图库;端侧几千节点单位数毫秒;放非阻塞快路径之外(承 §5.5)。退化:无边/超时→空(同现状)。

**B2 — 夜间巩固纪律【设计记录·待夜间巩固流水线】**:① **Nemori predict-calibrate 惊奇编码**(由已有语义记忆预测本情景→对比原文取 prediction gap→只蒸馏 gap 入语义),放夜间 dream pass(有 LLM 预算);② **Letta 读写分离 + 整块重写**(主体活时只读、夜间重生成 clean summary,不外科打补丁);③ **Graphiti LSH 去重前置**(ADD 去重在 SimHash 前加 MinHash/LSH 候选 + 熵门 + LRU,降本降方差)——其中 **LSH 前置可独立先做**(不依赖夜间流水线)。

**C1 — `compute_type` per-profile 接缝先行【实现中,接缝层】**:量化绑 profile 非 backend(RK3588=w8a8 / Jetson=int4 / Pi-PC=int8/float16)。各 Provider config(LLM/STT/TTS/Embedder)统一带 `device`/`computeType` 能力字段 + `requiresCuda` 等声明,留 `--target pc|raspberry|browser` 的 profile→config 解析接缝(本次只埋字段与解析 helper,cli 消费以后接)。

**C2/C3 — 端侧 LLM 藏 Provider 接缝 + Mycroft 入宪【设计记录】**:未来端侧 LLM(rkllama/llama.cpp/vLLM 均 OpenAI 兼容)直接走现有 openai-compat Provider,近零成本;**Mycroft 反模式入宪**:绝不让任一组件(尤其远程)成为不可降级依赖——已体现于 local-first + 可选云 + 模块可重写,作为硬原则记录。

**C4 — Memobase 式 profile 槽位【设计记录·待与 §5.3b 人物层一并做】**:`people` 的结构化 profile 用 topic→sub_topic→content 槽位 + 每槽自然语言"合并策略"(名字覆盖 vs 兴趣累积);profile 结构化召回**无需 embedding**(只事件用向量)。与现有 `relationship_state` 同属人物层,后续一并扩。

---

## 6. 人格与情感系统(承 v2.1 + LingYa/eros_ai 公式)

### 6.1 数值人格 + 情绪内核
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
  interaction_dials:        # 交互注意力旋钮(用户自治:外界交互时"谁优先")
    attention_mode: companion     # companion(默认:用户语音永远抢占外部能力) | balanced(用户仍最高,但她可"等我一下"、纯附和不打断) | focus(用户显式让她专注游戏/直播,仅长时坚持/关键词/危机才打断)
    per_capability: {}            # 进入某能力时热切覆盖,如 {game: focus, livestream: balanced}
  ```
  这些旋钮喂给 §7 的 stance 检测、IPC 姿态、autonomy 节流、**§7 的优先级事件队列(及未来「外界交互模块」)**,以及 §6 的 PAD 演化参数(intensity/spring_k)——**让"会反对/负面姿态/主动性/情绪性格/谁优先"都成为用户手里的刻度,而非固定行为**。`attention_mode` 的 baseline 还可由人格调制(如"我行我素"人格默认偏 focus,"黏人/高警觉"偏 companion)。
- **OCEAN→PAD**(Mehrabian 系数)+ **PAD 弹簧回归基线** `new=cur+0.3·pull−k·(cur−baseline)`(交互 k=0.2,idle k=0.01)。
- **冷启动**(chat-A 自有设计,非抄 LingYa):前若干轮情绪幅度减半 + 加速回弹,避免早期过拟合。
- **delta 演化**:即时 OCC→PAD(单次 LLM,省 token)+ 每 20 轮二级 OCEAN 信号分析(双 Pass,delta 上限 ±0.01)+ 版本快照 history。
- **情绪流水线(整体借鉴 LingYa)**:`OCC 22 情绪 → PAD 拉力 → IPC 对话姿态 → tone → 每轮 prompt fragment`,情绪是真实状态变量(心情差语气真会沉)。**🆕 IPC 姿态库需扩充负面态**(SULKING/WITHDRAWN),原 5 态全亲社会(详见 §7 行为需求 6)。
- **tone 注入**:静态骨架(身份/信念/护栏)+ 每轮动态 fragment(warmth/formality/humor/mood/stage 行为指令);tone 已能输出冷淡/俏皮等非助手腔。
- **自我一致性锚定**:LingYa `guard.py` re-anchor 扩展——回复与"语义召回的自我记忆"比对,漂移则重锚(**阈值放宽以允许有个性的偏离**,别把"我不同意"也当漂移拉回)。
- **夜间沉淀(借 Nexus dream)**:睡眠/低活跃时把 daily 压成长期记忆 + 反思 + 叙事线,并**自动写 Agent 第一人称自传记忆**(§5.3),摊销到本就要跑的 LLM。
- 公式/file:line 细节见 `reference-code-findings` §C/§D/§F/§G。

### 6.1b 关系亲密度 closeness(中速慢变量,2026-06-23)
> 调研发现 chat-A 缺"关系"这条轴(MeuxCompanion 等有 trust/affection 演化),详见 `github-learnings-2026-06-23.md`。补一个**单标量**填齐。

- **`closeness ∈ [0,1]`**:每个 `person_id` 一个,存 §5.3b `people.relationship_state` JSON(填实预留位)。**与人格(特质·慢)/ PAD(情绪·快)正交**,补齐缺失的"**关系**·中速"轴。
- **演化(单一权威公式)**:积极互动**缓升** `c += k·valence⁺·(1−c)`(valence⁺ 取当轮 appraiser 的 pleasure 正分量,渐近饱和);长期缺席**惰性衰减** `0.5^(days/H)`(同 §5.5 衰减族,读时实时算、不写回);速率/半衰期可配(行为即配置)。在**回合收尾**更新,**不进首字热路径**(承非阻塞约束)。默认初值 `0.1`(陌生起步)。
- **作用(单向 → 表达)**:喂 tone(warmth / 自我披露深度 / 称呼亲昵度:高 closeness = 更暖、更愿分享自己的事);(未来 autonomy 主动倾向钩子落地后)微调主动倾向。**绝不反向**改 OCEAN/PAD(避免难调反馈环)。
- **升级路径(标注,不实现)**:日后可把 `relationship_state` 扩为多维(trust/familiarity/affection),`closeness` 作其一或派生量;读写接缝与 JSON 存储天然支持,无 schema 迁移。

### 6.2 用户自定义 Persona 创作(用户自治的落地)
角色不是设计者写死的,**用户自己造**:
- **角色背景设定 / 故事**:用户填写人物的身份、背景故事、性格、爱好、说话风格 → 成为人格种子(YAML)+ 自我 lore(§5.3,embedding 进向量库供语义召回)。
- **用户画像(关于用户自己)**:用户可主动填入自己的画像/偏好/背景,作为 `subject=user` 的种子记忆(冷启动即"已认识你"或保持"慢慢了解",由用户选)。
- 全部**可编辑、运行时热加载**(配置热加载,承 v2.1)。
- **🆕 card-as-config 打包**(借 AIRI,但保留 chat-A 数值内核):一个 `PersonaCard` 捆 `{ocean, pad, systemPromptText, greetings, examples, bindings:{llm,tts,embed}}`——数值 OCEAN/PAD 渲染进系统提示(数值→形容词),连续 PAD 映射到最近离散情绪供 TTS/表情表达;情绪→表情映射作为人格配置一部分(非硬编码)。**chat-A 的数值演化人格领先开源界**(三参考项目人格全是纯文本 prompt)。详见 `neuro-ecosystem-findings-2026-06-22.md` §4。

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
   - **🆕 反谄媚原则(2026-06-23 调研,详见 `github-learnings-2026-06-23.md`)**:反谄媚 = 系统基于**真实信念冲突**(`core_belief`/`self_notions`)的**自主涌现判断,非强制机制**;**双向防偏**——既不被用户压服成谄媚,也不"为反对而反对"(performative contrarianism,lechmazur Contrarian rate 所测的失败模式),两者都偏离真诚、都反伴侣。assertiveness 仍用户自治;"必须开口"由危机/安全底线(不可配,§0)覆盖。**暂缓(已记录、不采纳)**:同意连击熔断器 / 主动性硬下限 / 生成后改写 pass(均属强制反谄媚,留未来可选/eval)。**eval 指标(只测不逼)**:SYCON-Bench Turn-of-Flip/Number-of-Flips(测被压服)+ lechmazur Contrarian rate(测硬顶)+ persona_drift 探针(测人格漂移)。
4. **对话风格 = 人不是 essay**(`TurnStrategy` 生成纪律):话短、口语、有口头禅、会"嗯嗯"接话、用共同的梗;禁"作为AI…"/过度解释。借 LingYa tone(已能输出冷淡/俏皮腔)。
5. **从语音读情绪 prosody**(`stt`/情感预检测):听出疲惫/低落(怎么说的),不只是说了什么。Nexus 已有语音韵律情绪信号可借。
6. **可控的不完美 + 负面情绪姿态**(记忆衰减 + 心情影响):外围记忆允许模糊、心情影响状态;**🆕 IPC 新增 SULKING/WITHDRAWN 等负面姿态**(LingYa 5 态全亲社会,缺"赌气/冷淡/我现在不想说话")。**🎛️ 负面姿态表达程度由用户可调**(`negative_affect_expression` 旋钮 0→1:从"永远愉悦不闹脾气"到"完整表达坏心情/会赌气冷淡")。核心事实永不忘(§5.4)。

**autonomy/ 模块**(后台主动 loop,与反应式 loop 分离)——借鉴 Nexus 管线:`tick → gather context → 决策 LLM(silent|speak|idle_motion,多数 silent)→ persona guardrail → speak`;三道节流(每日上限 + 动态 cadence[相位×情绪×idle×关系] + inflight 锁);情绪→主动倾向 `resolveProactiveLean`(restraint-first,只在边界微调);idle 情绪弧 once-per-episode(想念/重逢)。默认可关,P4 启用。**未来深入研究方向:Agent 后台自主活动 + 内生内在生活。**

**🆕 autonomy 工程化(Neuro 生态深读,详见 `neuro-ecosystem-findings-2026-06-22.md` §5):**
- **通用 `SkillScheduler` + `BaseSkill` 框架**:autonomy 不做成单一 Monologue 循环,而是**可插拔后台技能**(主动跟进/反对/情绪姿态/夜间沉淀各一 skill)。单循环 reconcile 多技能,`enabled` **每 tick 现读 config**(改配置/API 下一 tick 生效无重启),生命周期四钩子 `initialize/start/stop/update/onConfigReload`,per-skill inflight 锁。爆炸半径可控、默认可关——命中模块化+行为即配置。
- **统一 `requestSpeak()` 输出仲裁器**:所有后台技能"想说"走同一入口,据忙闲(单一 `is_speaking` 硬闸)+ **优先级/抢占**决定真说 / 记 history 待续 / 丢弃,persona guardrail 插这层。**比"各技能自觉退避"更强**,为"会反对、会插话、情绪占用通道"打基础。打断保存 resumeBuffer,用户回 backchannel("继续/嗯")续播。
- **自激内在生活 + no-action 预算节流**:autonomy loop 用**单消费者优先级事件队列**(语音=URGENT / 计时器·记忆唤起·情绪漂移=PERCEPTION / "要不要主动开口"=最低优先级)——**不用 `setInterval` 驱动认知**;一轮没产出动作就塞合成事件"再想一次"但扣预算(默认 3 次),用户开口重置预算并丢弃排队的自言自语。这是"有内心独白但不刷屏/不空转"的干净旋钮。
- **⭐ 用户语音优先级原则(默认 URGENT,但可配 = 伴侣定位的"软反转")**:Neuro 官方 SDK 是**世界/游戏优先**(游戏可 `force` 打断 AI 说话);chat-A **默认反转为人优先**——用户开口立即抢占一切外部能力(游戏/直播/定时),触发 abort 三件套中断在飞的 TTS/动作,先听你、先处理你。这是"伴侣会停下手里的事看着你"的体感来源,也保证带情绪的语音(prosody)永不漏听。
  - **URGENT ≠ 服从**:这条管的是**注意力/感知优先级**(永远第一时间听见你、停下来),**不是服从**——听见之后她可同意/反对/拒绝/说"等我一下"。"先全情投入地在乎你 + 再决定自己的立场"才是完整伴侣,与"会反对/有边界"不冲突。
  - **用户自治:做成可配旋钮**(§6 `interaction_dials.attention_mode`):`companion`(默认抢占一切)/ `balanced`(仍最高但她可短暂保持当前动作、附和不打断)/ `focus`(用户显式让她专注某游戏/直播,仅长时坚持/关键词/危机才打断);可 `per_capability` 热切,baseline 受人格调制。
  - **不可配的底线**:① **永远感知/捕获**用户语音(即使不立即响应,绝不"装聋",prosody 不丢);② **危机覆盖**(危险信号永远最高,无视任何模式,承 §0);③ **硬打断通道始终保留**("停一下/看着我"任何时刻把她拉回)。
  - **落地**:`attention_mode` 调三个量——用户语音事件在队列中的等级、是否触发 abort 三件套打断她正在说的话/在飞外部动作、"判定为真打断"的门槛(focus=要求更长坚持/关键词,而非真聋)。游戏动作默认压低(low/medium),**绝不发 critical 抢占用户语音**。
- **给模型一个"沉默"工具**:让 LLM 显式选择不回应(系统提示明说"不必回应每个信号"),叠加衰减概率 governor(被提及/触发词加分、空闲衰减),base rate 由 PAD/OCEAN 调制。
- **🔧 worth-of-speaking 的定位修正(2026-06-23 GitHub 调研,详见 `github-learnings-2026-06-23.md`)**:"是否值得说"**已是既有先验技术**——**Inner Thoughts**(CHI 2025,开源:8 因子动机量表 → CoT 权衡 → 说/打断双阈值)、**ProactiveAgent**(学习型奖励模型 + False-Alarm 分类 + 反馈防刷屏)、**Proact-VL**(微软实时陪伴,自主决定何时/多久/语速)均已实现打分式评估。**故不再宣称"别人只定时器、我们独有评估"**;chat-A 可防守的差异化在**组合**:决策 LLM(silent|speak|idle)+ **三道节流** + **跨会话持久内在生活** + **会反对/不服从** + 可插拔 SkillScheduler + no-action 预算单消费者优先级队列(无单一项目集齐)。真实蓝海:**§7#1 内在生活 + open-thread 主动跟进 + 会反对**。
- **🆕 判断力增益(决策 LLM prompt,待决策 LLM 实现时落入)**:"是否值得说"采用 **Inner Thoughts 8 因子动机量表**(关联 / 信息缺口 / 预期影响 / 紧迫 / 连贯 / 原创 / 平衡 / 动态)作评估维度——**给系统更好判断依据,非强制规则**(量表权重/启用可配)。**eval(只测不逼)**:记 ProactiveAgent 的 False-Alarm / Missed-Needed / Non-Response / Correct 四分类为 autonomy 决策评估框架。

---

## 8. 容错 / 网络 / 安全 / 协议

- **两条网分治**:终端↔大脑(新故障,心跳+指数重连 1s→30s+保活窗口)/ 大脑↔云(原 Provider failover,退避 `[1m,5m,25m,60m]`)。
- **状态归属**:会话/业务状态在大脑(落 SQLite),呈现状态(指示灯)在终端。终端崩→大脑保活;大脑崩→SQLite 恢复。
- **终端最小本地资产**:断网时预存提示音 + 1~2 句缓存语音,否则断网即哑。
- **安全(P2)**:WSS/TLS + 终端鉴权握手(token/设备证书)+ 每连接会话隔离。
- **协议版本化(P0)**:握手交换 `protocolVersion`,大脑兼容当前+前 1 次版本,破坏性变更升主版本并明确拒绝过旧终端。

### 8.1 可追溯性 / 可观测性(开发期硬要求)
> 复杂管线(语音→STT→记忆召回→人格/情绪→LLM→分类→TTS→打断→autonomy)里,"它**为什么**这样表现"无法靠直觉调试。**每个行为必须可被完整重建**,才能定位并修复开发期问题。从 P0 起就埋,不是事后补。

- **关联 ID 贯穿全链**:`sessionId / turnId / generation / requestId / person_id` 串联终端↔大脑↔云的每条日志与每帧——任一行为可端到端追溯。
- **🆕 OTel 做追踪骨架(关联ID/context/span 树/延迟)**(2026-06-22 深读 OTel 确认,详见 `voice-infra-findings-2026-06-22.md` §6):AIRI 式"AsyncLocalStorage 自动传播 traceId"**正是 OTel JS 默认的 `AsyncLocalStorageContextManager`(基于 Node `AsyncLocalStorage`)**——**直接用 `@opentelemetry/sdk-node` 当骨架,不自造**:关联 ID 设为 span 属性/baggage、trace_id/span_id 跨 async 传播免费、W3C `traceparent` 跨进程(树莓派↔PC↔远端 Provider)现成。span 树 `session → turn → {stt,llm,tts,classify,autonomy}`;LLM span 用 **GenAI 语义约定**属性(`gen_ai.operation.name=chat`/`gen_ai.provider.name=anthropic`/`gen_ai.request.model`/`gen_ai.usage.input_tokens·output_tokens`/`gen_ai.output.type=speech`/`gen_ai.conversation.id`=sessionId;⚠️ 全 Development 级会变,锁版本)。延迟用 metric Histogram(仿 LiveKit `lk.agents.turn.*`),span 起止**锚定语音真实时刻**而非协程恢复时刻。跨 task 边界纯 ALS 会断,需像 Pipecat 显式存 turn 的 SpanContext 兜底。事件仍 `deepFreeze` 不可变 + 每订阅者 try/catch 隔离。
- **🆕 per-handler 延迟预算监控 + 泛型信封**:总线每 handler 记录耗时、**超预算只告警不杀**(承 §3.2 延迟预算落到总线本体);跨进程信封 `{protocol, version, action, code, data, correlationId}`,`action` 复用进程内事件名常量——**一套命名贯穿 bus/WS/日志/trace**(`correlationId` 一回合内继承,不每次新生成)。
- **每回合决策 trace**(结构化,落 SQLite):记录该回合**完整决策链**——输入、**召回的记忆 + 各项打分**、当时人格/情绪(PAD/IPC)状态、**最终组装的 prompt**、用的 Provider/model、LLM 原始输出、分类/过滤结果、各阶段延迟。→ 可回答"为什么召回这条/为什么这语气/为什么这 Provider"。
- **autonomy 决策可追溯**:记录每次 tick 的 silent/speak 决策**及其输入与理由**(为什么沉默/为什么主动)。
- **三层日志 → SQLite**(承 v2.1):`event`(总线 `onAny` 全量)/ `metric`(延迟/成本)/ `error`;`bus.history` 留最近 N 条。
- **可重放**:SQLite 为单一真相源 + trace 落库 → 能**重建/回放**一个有问题的回合来复现 bug。
- **🆕 两层追踪,同 ID 缝合(关键)**:**OTel trace** = 实时·可采样·运维导向(延迟剖面/关联ID骨架/跨服务,span 短命、默认不存完整 prompt);**SQLite 决策 trace** = 持久·不采样·单一真相源·可重放(存完整 prompt+召回打分+PAD/IPC,回答"她为什么这么说")。**二者用同一 `trace_id/span_id` 缝合**——SQLite record 存 trace_id/span_id,OTel 发现慢回合可跳到 SQLite 完整决策。**可重放绝不靠 OTel(采样会丢)→ SQLite 必须无条件全量**;OTel 才能采样。落地:自写一个把 span 落 SQLite 的 SpanProcessor/Exporter(Pipecat `setup.py` 的扩展点),复用 OTel 骨架但真相留本地。
- **分级开销 + 隐私脱敏**:`debug` 级捕获**完整 prompt/打分(只落本地 SQLite,不导出远端 OTLP)**;`prod` 级采样+精简(不写 prompt)。prompt 含敏感记忆 → 落库前过**脱敏接缝**(承 Pipecat `get_messages_for_logging` 先例,与 §3.2 隐私优先一致);大 prompt 别塞 span 属性。⚠️ 树莓派上 flush/shutdown 加硬超时(LiveKit 踩过 30–90s 卡顿)。
- 配合 §3.1 契约测试:问题定位到模块后,在其接口边界加回归用例。

---

## 9. 开发顺序

| 阶段 | 内容 |
|------|------|
| **P0** | monorepo + protocol(含 version + 泛型信封/correlationId)+ `AudioTransport`/`InProcessTransport` + 终端/大脑拆分;**🆕 Pipecat 式帧管线骨架(§4.2 B 层:四态帧+双队列)+ 事件总线(LightVoiceBus,A 层)+ `@opentelemetry/sdk-node` 追踪骨架(§8.1,从第一天埋)+ Randy 式 `FakeLLM` 测试桩(WS+HTTP 注入)** |
| **P1** | 本地单机跑通;VAD + `SilenceTimeoutDetector` + `SingleShotStrategy`;**SQLite 中期记忆(真相源)+ 关键词召回 + 写路径 ADD+去重(§5.8)**;人格 OCEAN+PAD+冷启动;**用户可调人格/情感旋钮 + 用户自填角色背景/用户画像**(§6.2);锁单用户 |
| **P2** | `WebSocketTransport`+心跳/重连;跨网络 generation;WSS/鉴权;**`Embedder`(BGE-M3)+ 向量库 + 语义检索(双主语)+ 情感共振 + 混合召回打分归一(§5.5)**;**Redis 工作层 + 巩固流水线**;`SmartTurnDetector` A/B;**语音 I/O 输入/输出语种解绑(§4.1)**;行为层 #4 对话风格、#5 prosody 起步 |
| **P3** | 终端能力自适应;容错完善;(备选)WebRTC;`ToolCallingStrategy`(Agent loop,§3.3)+ **外界交互模块 §12 MVP(MCP client + CapabilityRegistry + ProcessSupervisor + 内置感知源/动作)**;delta 演化 + **离线双 Pass 调和(update/delete,§5.8)**;行为层 #1 跨会话连续、#2 主动跟进、#3 反谄媚(可调);**说话人识别(声纹/diarization)+ 多人对话(单主用户锚定)(§5.3b)**;**图片生成人物画像(§6.3,多模态)**;**Live2D 可视化(§6.4,非嵌入式)** |
| **P4(演进)** | `gemma4-local`(LiteRT-LM)+ 手机合体;启用 `autonomy/`(含负面姿态可调);记忆 lite profile(sqlite-vec)端侧验证;**用户组(每人独立关系)+ Agent 自主纳入成员(§5.3b)**;**外界交互演进:直播/游戏能力(§12.4,默认关)+ Neuro 专有 force/priority 等(§3.3 🅽 解冻评估)** |
| **后续大版本** | 多租户(多个独立主用户各一套伴侣);Zep 式记忆有效期窗口;Persona Vectors(端侧) |

---

## 10. 伴侣感验收 Rubric(比功能测试更重要)

- **回合级**:回复够短?有共情?像人话还是 essay?有没有"作为AI"?
- **关系级(长期)**:跨会话记得?主动跟进了?心情有连续性?会不会自相矛盾?亲密度在演化?
- **反例级**:会谄媚吗?会无脑同意吗?会突破伦理边界制造依赖吗?

每次迭代据此打分——"伴侣感"是可验收的,不是口号。

---

## 11. 待决项

- [x] ~~向量库具体选型~~ **已定(2026-06-23)**:**单轨 sqlite-vec**(端 + PC),不上 Qdrant/Chroma/pgvector(无多用户高并发需求,§5.6);记忆量逼近 ~10 万或弱 CPU 超延迟预算时**平替 LanceDB(IVF_PQ)**。
- [x] ~~Redis 持久化策略~~ **已定(2026-06-23)**:单机项目**不引入 Redis**,工作层用 **SQLite 内存表/进程内**(真相仍在 SQLite,§5.2/§5.6);Redis 仅作未来横向扩展的可选项。
- [ ] 巩固流水线触发节奏(会话结束 + 每日 + 每 N 轮)。
- [ ] 大脑保活窗口 N 分钟取值;每日主动问候上限。
- [ ] Gemma 4 license 商用核实。
- [ ] 人格/边界的**用户配置项**设计(用户自定义人格、关系深度、是否启用最小危机底线)——体现"用户自治"。
- [ ] **🆕 EOU 本地模型选型**(§4 动态 endpointing 的 mini ONNX:LiveKit turn-detector vs Pipecat Smart Turn v3 vs 自蒸馏)。
- [ ] **🆕 附和/打断分类无开源本地模型**(§4):初期启发式(VAD+min_words+min_duration+backchannel_boundary)降级,后续是否自建。
- [ ] **🆕 自打断防护方案**(§4):AEC vs "agent 说话时门控 STT" 二选一/并用,树莓派可行性。
- [ ] **🆕 OTel→SQLite 落地**(§8.1):自写 SpanProcessor/Exporter 把 span 落 SQLite 决策 trace 的实现 + 采样策略。
- [x] ~~**🆕 向量库 ANN 索引**~~ **已定(2026-06-23)**:单用户记忆量级(几千~几万条)**sqlite-vec 暴力 KNN 即够**(1024-dim float 在 10k 量级实测 <75ms);初期不引 ANN,超 ~10 万再切 **LanceDB IVF_PQ**(§5.6/§5.9)。存储吃紧用 int8 量化(1/4,近无损)。
- [ ] **🆕 MCP 能力进程清单**(§12):首批接哪些外部能力(本地工具 → MCP server),stdio vs HTTP 传输选择。
- [ ] **🆕 全双工式编排层**(收敛上方 EOU 本地模型选型 / 附和打断分类 / 自打断防护 三项 + 新增 pVAD 目标说话人VAD、TurnController 决策核收口、(A)(B) 全双工区分与 `FullDuplexAudioSession` 接缝):初步方案见文档索引的 `2026-06-26-full-duplex-orchestration-layer-PRELIMINARY.md`(brainstorm 草稿,⚠️挂起,待语音 I/O 真机测试通过后正式立项)。

---

## 12. 外界交互模块(感知 / 行动 / 能力接入)
> 让"小雪"能**感知**外界、**行动**于外界的统一子系统;除核心语音对话外,一切与外部世界的输入/输出都从这里进出。挂在**服务端大脑侧**,经 §4.2 A 层模块总线解耦、关联 ID 贯穿。**只做"采集→归一→去抖→喂 signal"与"动作注册→执行→回灌",不做决策**(决策在 cognition)。任一外部源/能力崩溃**不拖垮主对话**(§3.2 优雅降级)。

### 12.1 感知侧(世界 → Agent)
- 统一 `PerceptionSource` 接口(`id / modality(heard|sighted|felt|temporal|system) / start(emit) / stop / health`),每源自管采集(回调/轮询/ws),发**结构化** `raw:<modality>:<kind>` 事件(别过早描述化)。
- **三层去抖**:源内边沿 latch → 滑窗 detector(纯函数,阈值走配置)→ 0.3s **聚合窗**(合并多源防七嘴八舌),fire `signal:*`(带 `description`+`metadata`+`confidence`)。
- **被动触发 vs 主动拉快照**清晰分界:用户语音/强信号=触发认知回合;时间/环境/记忆=回合内主动拉 snapshot 且**只在变化时**注入 prompt(diff);低价值上下文旁路注入历史**不唤醒**。
- **MVP 内置源**:麦克风(来自语音管线)、**时钟心跳**(`system.tick`,驱动主动性/作息感知)、系统通知。树莓派友好;GPIO 传感器(光/温/PIR)天然走 `felt` 模态。

### 12.2 行动侧(Agent → 世界)
- `ActionRegistry`:`Action{name, description, schema(Zod), capability门, validate, perform(world)}`;**validate→回发结果→execute** 拆分(校验过即给"在做了"反馈降延迟);能力门**动态隐藏**设备不支持的动作。
- `TaskExecutor`:经 §4.2 A 层总线发 `action:started/completed/failed`(带 correlationId),与对话回合**异步耦合**(结果回灌为下回合 context);单飞行 + 取消(打断回滚)。
- **MVP 内置动作**:本地能力(提醒/定时、播放控制、查询时间天气、表情/灯光),纯本地无外部进程。
- 模型侧契约见 §3.3(Anthropic 原生 tool-use:完整 JSON Schema+strict、tool_use/tool_result、原生并行、流式)。

### 12.3 能力接入 / 具身(跨边界)= 锚定 MCP
> **外部能力(游戏/外设/第三方服务)作为独立进程/远端时,一律走 MCP 协议接入**(承 §3.3 决策,详见 `neuro-ecosystem-findings` §1):
- **大脑 = MCP client,能力进程 = MCP server**;`initialize`+protocolVersion 协商 → `tools/list`(分页)→ `tools/call{name,arguments}`;**`notifications/tools/list_changed` = 动态 register/unregister**(上线推送 = MCP server 发 list_changed,大脑重拉)。
- 结果 `content[](text/image/audio/resource)`+`isError`;**错误双轨**(JSON-RPC 协议错误 = 系统/基础设施 `fault`,`isError:true` = 工具业务错误)正好映射 §3.3 错误归因。
- **传输**:stdio(本地·树莓派外设)+ Streamable HTTP(远端·未来合体)——对应"transport 可插拔";`MCP-Protocol-Version` 头贯穿。
- **CapabilityRegistry + ProcessSupervisor**:进程拉起/健康探活/崩溃自愈(**指数退避+jitter**)/LIFO 优雅关闭;核心能力强制监督、可选能力可降级不阻塞启动(承优雅降级)。
- **边界翻译**:MCP 工具在 gateway/runtime 边界适配成 Anthropic tool 定义喂模型,**强制 `mcp_server.tool` 命名空间**防同名静默覆盖;Claude 原生 MCP connector + SDK 转换器使两层无缝。
- **接缝 3 终端能力声明 = MCP 的一个实例**:瘦终端"我有麦/扬/屏"、外设、第三方服务统一走 MCP `tools/list`/能力声明,统一进 CapabilityRegistry。

### 12.4 范围与开发顺序
| | 范围 |
|---|---|
| **MVP(本模块基本功能)** | 感知源框架 + 内置源(麦/心跳/通知);ActionRegistry + 内置本地动作 + TaskExecutor;MCP client + CapabilityRegistry + ProcessSupervisor;接缝 3 终端能力声明走 MCP |
| **演进(默认关,后续阶段)** | 更多 MCP 外部能力源(含 prompt 模式降级给无原生工具的小模型);**直播**(弹幕=感知源 + OBS/形象=行动汇 + 高价值事件优先队列,详见 `neuro-ecosystem-findings`);**游戏**(具身行动实例,动态枚举 schema,回合制优先) |

- ⭐ **用户语音永远 URGENT 优先于一切外部能力**(§7 软反转,`interaction_dials.attention_mode`):游戏动作压低优先级,绝不 critical 抢占用户语音。
- 🅽 **Neuro SDK 专有的 force+priority/阻塞 result/context(silent) 暂不纳入**(§3.3),做"主动行动/陪玩"时再叠加。

---

## 文档索引
- 本文 = canonical 设计。
- `reference-projects-research-2026-06-18.md` — 外部开源对标(mem0/Letta/Zep/LiveKit/Pipecat/LiteRT-LM…)。
- `reference-code-findings-2026-06-18.md` — 本地参考源码可复用清单(公式/file:line/校正)。
- `neuro-ecosystem-findings-2026-06-22.md` — **Neuro 生态深读**(官方 neuro-sdk + AIRI/Open-LLM-VTuber/RealtimeVoiceChat/projectBEA/Zerolan 等),逐文件精读的增量可借鉴设计(file:line)。源码克隆于 `reference/github-projects/neuro-ecosystem/`。
- `voice-infra-findings-2026-06-22.md` — **实时语音 infra 深读**(LiveKit Agents + Pipecat),帧管线骨架(已采用,§4.2)+ 预测性生成/动态 endpointing 等增量 + §6 OpenTelemetry 对照 §8.1(file:line)。源码克隆于 `reference/github-projects/voice-infra/`。
- `memory-frameworks-findings-2026-06-22.md` — **记忆框架深读**(mem0/Letta/OpenMemory/Memoripy)对照 §5:打分归一/衰减/检索强化/写路径决策 + round-1 头条订正(file:line)。源码克隆于 `reference/github-projects/memory-frameworks/`。
- `superpowers/specs/2026-06-18-embedded-adaptation-design.md` — 适配/接缝推导过程(已并入本文)。
- `superpowers/specs/2026-06-26-full-duplex-orchestration-layer-PRELIMINARY.md` — **全双工式编排层 初步设计草稿(⚠️ brainstorm 产物,未定稿/挂起,待"音频设备选择+采样率解耦"切片真机测试通过后再正式立 spec+实现)**。承接本文 §3.2.2/§4/§4.2 已有的打断/延迟工程(抢先生成 / EOU 概率动态 endpointing / 先 pause 后定夺打断+resume / backchannel / 半句写回);增量为:TurnController 决策核收口、pVAD 目标说话人 VAD(填 §11 "附和/打断分类无本地模型"缺口)、turn-taking 绑 §6/§7 人格档、(A) 真模型级全双工 vs (B) 编排层 区分 + `FullDuplexAudioSession` 接缝预留 + MiniCPM-o 路线。参考源码克隆于 `reference/github-projects/full-duplex-refs/`(FireRedChat/LiveKit agents-js+python/pipecat/unmute)。
- `chat-a-final-design.md` / `real-time-agent-design.md` / `chat-a-architecture-design.md` — 历史/细节附录(被本文取代,保留备查)。
