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

2. **延迟预算(实时语音的命门)**
   - 每阶段定延迟预算(首 token / 首音频),**流式贯穿全链**;新功能加延迟必须论证;延迟进 trace(§8.1)。延迟一高就"不像人"。

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
- **⚠️ chat-A 的超越点**:三参考项目自主性**全是定时器触发,从不评估"此刻开口是否值得/用户会不会烦"**。chat-A 的 `决策 LLM(silent|speak|idle) + 三道节流` 把"是否值得说"作为**一等决策**,是质的超越——这是差异化护城河,须自创。

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

- [ ] 向量库具体选型(服务端 Qdrant vs Chroma vs pgvector;端侧 sqlite-vec)——P2 前定。
- [ ] Redis 持久化策略(AOF / 纯缓存可重建)——倾向"纯可重建,真相在 SQLite"。
- [ ] 巩固流水线触发节奏(会话结束 + 每日 + 每 N 轮)。
- [ ] 大脑保活窗口 N 分钟取值;每日主动问候上限。
- [ ] Gemma 4 license 商用核实。
- [ ] 人格/边界的**用户配置项**设计(用户自定义人格、关系深度、是否启用最小危机底线)——体现"用户自治"。
- [ ] **🆕 EOU 本地模型选型**(§4 动态 endpointing 的 mini ONNX:LiveKit turn-detector vs Pipecat Smart Turn v3 vs 自蒸馏)。
- [ ] **🆕 附和/打断分类无开源本地模型**(§4):初期启发式(VAD+min_words+min_duration+backchannel_boundary)降级,后续是否自建。
- [ ] **🆕 自打断防护方案**(§4):AEC vs "agent 说话时门控 STT" 二选一/并用,树莓派可行性。
- [ ] **🆕 OTel→SQLite 落地**(§8.1):自写 SpanProcessor/Exporter 把 span 落 SQLite 决策 trace 的实现 + 采样策略。
- [ ] **🆕 向量库 ANN 索引**(§5.8):随上方向量库选型一并定(避开全表扫描余弦)。
- [ ] **🆕 MCP 能力进程清单**(§12):首批接哪些外部能力(本地工具 → MCP server),stdio vs HTTP 传输选择。

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
- `chat-a-final-design.md` / `real-time-agent-design.md` / `chat-a-architecture-design.md` — 历史/细节附录(被本文取代,保留备查)。
