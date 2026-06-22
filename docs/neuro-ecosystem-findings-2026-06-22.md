# Neuro 生态深读发现:可借鉴设计清单(2026-06-22)

> 方法:克隆 10 个 Neuro 相关开源到 `reference/github-projects/neuro-ecosystem/`,派 6 个 agent **逐文件精读真实源码**(非 README),提取 chat-A 方案**尚未覆盖的增量设计**,带 file:line。
> 配合 `reference-code-findings-2026-06-18.md`(voice-core/Nexus/LingYa/eros_ai)使用;本文为**第二批**(Neuro 生态)。
> 标注:🆕=方案增量(应纳入) | ✅=确认现有决策正确 | ⚠️=反面教材/要避开。冲突以 canonical 设计为准。
> 路径前缀均相对 `reference/github-projects/neuro-ecosystem/`。

---

## 1. TurnStrategy / Agent loop / 工具调用(对应接缝 5)

来源:neuro-sdk(官方协议)、Open-LLM-VTuber。

- 🆕 **三段式工具调用:`validate → 回发 result → execute`,结果先于副作用**(`neuro-sdk/Unity/.../CommandHandler.cs:45,63,65-68`;规范 `API/SPECIFICATION.md:168`)。参数一合法就把结果回灌 LLM 让它继续说话,副作用 execute 异步在后。`validate(args)` 是纯函数 → 直接满足"可测试性";降延迟。
- 🆕 **能力驱动工具调用 + 运行时优雅降级到 prompt 模式**(Open-LLM-VTuber `openai_compatible_llm.py:216-223`、`basic_memory_agent.py:484-494`、`mcpp/json_detector.py:90-121`)。Provider 带 `support_tools` 标志;原生失败→yield `__API_NOT_SUPPORT_TOOLS__` 哨兵→agent 切 prompt 模式,用**括号配平流式 JSON 检测器**从纯文本抠工具调用。教科书级"优雅降级",树莓派本地模型必备。
- 🆕 **动态枚举 schema——让非法调用不可表达**(`neuro-sdk/.../TicTacToe.cs:129-137,164-174`)。工具参数 schema 每回合按真实状态生成(当前歌单、真实记忆标签),把约束前移进 schema,省"报错—重试"往返。配合官方实测 schema 关键字黑名单(`SPECIFICATION.md:58`)只用最小子集(type/enum/required/properties)。
- 🆕 **动态 register/unregister + `_dyingActions` 撤销宽限期**(`neuro-sdk/.../NeuroActionHandler.cs:19,46-58`)。工具集随情境实时增删;刚下线的工具进 10s 临死名单,LLM 若仍调用返回**专属语义**("这能力刚不可用"≠"没这能力"),治实时语音里"LLM 决策基于几百 ms 前上下文"的竞态。
- 🆕 **错误归因后缀**(`neuro-sdk/.../ExecutionResult.cs:18-19`、`NeuroSdkStrings.cs:8-9`)。工具结果带 `fault: system|tool|user-input` 维度并拼人话后缀:LLM 不会把系统故障道歉成"我错了";trace 自带归因,开发期零成本区分"模型乱传参 vs 工具坏了"。
- 🆕 **force + priority = 主动性载体 / 单飞行回合状态机 / 重试集中在一处**(`SPECIFICATION.md`;`ActionWindowResponse.cs:20-21`)。autonomy 主动注入 forced turn("现在该主动开话题/表达反对");`priority` 对应延迟预算(critical 抢占/low 可丢)。重试逻辑收归回合状态机单点,客户端工具层永不自重试(防副作用翻倍);提供"软失败"(success=true+错误文案)规避重试。
- 🆕 **Agent 整体可换接口(3 方法)**(Open-LLM-VTuber `agent/agents/agent_interface.py`):`chat()→AsyncIterator<Output>` / `handleInterrupt(heard)` / `loadMemory(id)`。把"记忆策略+工具+人格"整体抽成可换 agent,而非只换 LLM。
- 🆕 **输出多态 `SentenceOutput | AudioOutput`**(Open-LLM-VTuber `agent/output_types.py:45-77`):文本 LLM→TTS 与端到端语音模型(直接出音频)走同一 chat 循环,tagged union 消费。

---

## 2. 语音管线 / 延迟 / 打断(对应 §4、接缝 1/4)

来源:RealtimeVoiceChat、AIRI、Open-LLM-VTuber、Neuro。

- 🆕 **打断 abort 三件套**(RealtimeVoiceChat `speech_pipeline_manager.py`):① per-stage `request/finished` 事件**握手**+逐阶段超时(`:184-189,378-382,878-941`)——abort 不是 fire-and-forget,是带超时的同步握手,保证下一回合启动前上一回合资源真清干净;② `abort_block_event` **闸门**(`:191-192,872,982`)abort 进行中冻结新回合启动,杜绝新旧状态交叠;③ 请求队列 **drain 只取最新**+2s 去重(`:242-256`)。Node 用 `AbortController` + `abortInProgress: Promise` 落地。
- 🆕 **Intent 优先级抢占统一"打断"**(AIRI `pipelines-audio/src/speech-pipeline.ts:321,407-419,423`)。每段输出=带 `behavior:queue|interrupt|replace` + `priority` 的 intent;用户开口=critical intent 抢占她正在说的 normal。**一个 AbortSignal 串起 LLM/TTS/播放**(`:329,204,252,262`)保证打断零残留。优先级常量 `priority.ts:3`(critical300/high200/normal100/low0)。
- 🆕 **乱序生成、顺序播放(sequence 重排)**(AIRI `speech-pipeline.ts:127,174`;Open-LLM-VTuber `conversations/tts_manager.py:70-114`)。多句并发跑 TTS(降首音延迟)+ 单调 seq + 重排 buffer 严格保序;空文本走静默 payload 仍下发表情/动作。
- 🆕 **流式 TTS chunker + 前 N 句 boost 抢首音**(AIRI `processors/tts-chunker.ts`,纯 Node 零依赖可逐行抄;RealtimeVoiceChat `text_context.py:33-73` 边界规则含中文标点;Open-LLM-VTuber `SentenceDivider`)。`Intl.Segmenter` 分词、硬标点立即出句、软标点缓冲、minWords/maxWords、`yieldCount<boost` 强制小句快出。
- 🆕 **流内带外信号**(AIRI `tts-chunker.ts:9-10`):零宽字符 `⁣`(special:情绪/音效点)、`​`(flush:强制出句),不被 TTS 朗读又能携带情绪/动作时间点,与音频片精确对齐。
- 🆕 **流式控制指令解析 + 回合级 handler 隔离**(AIRI `llm-streaming-control/controller.ts:46,163,189`):LLM 流里发 `act`(情绪)/`call`(工具)/`delay`(停顿模拟真人节奏);`beginTurn()` 给每回合开隔离 handler 作用域 + 可 await 的 `done` promise(=trace 边界 + 打断时 cancel 当回合所有挂起 handler)。
- 🆕 **自校准延迟预算**(RealtimeVoiceChat `speech_pipeline_manager.py:170-172,214-215`;`audio_module.py:178-215`;`turndetect.py:492-496`)。启动期实测 TTFT/TTFA,反馈为轮次检测静音等待**下限**:`silenceTimeout = max(modelPause, measuredLatency + overhead)`。把"延迟预算"从写死阈值升级为自适应,树莓派/PC 自动适配。
- 🆕 **partial 抖动相似度门控**(RealtimeVoiceChat `speech_pipeline_manager.py:442-532`,阈值 0.95)。新 partial 与正在生成文本末尾 5 词比相似度,≥0.95 忽略(STT 30ms 抖动不自打断),否则才 abort 重启。Node 用末尾词 trigram 相似度,无需模型。
- 🆕 **"hot" 预测性抢跑**(RealtimeVoiceChat `transcribe.py:235-318`):距判定轮次结束还剩 ~0.25s 就允许预启动 LLM/TTS,把启动延迟藏进用户尾音;用户继续说则 abort(需配廉价 abort)。
- 🆕 **双向打断闭环**(RealtimeVoiceChat `ttsPlaybackProcessor.js:11-19,31-43`;`server.py:782-810`):播放 worklet 边沿上报真实播放状态;**据"客户端真在播"才算打断**;打断=服务端 abort 生成 **且** 客户端 worklet `clear` 立即排空已缓冲音频(否则已下发音频仍播完)。
- 🆕 **TTS 首段自适应 jitter buffer**(RealtimeVoiceChat `audio_module.py:264-352`):缓冲到"合成速度跟得上播放"(good_streak≥2)或 500ms 才开闸,防开头卡-冲;可作弱设备优雅降级旋钮。跳开头静音 chunk 省 TTFA(`:285-310`)。
- 🆕 **STT 失败语义区分 + 背压丢帧**(RealtimeVoiceChat `audio_in.py:87-117,166-206`;`server.py:280-288`):区分 CancelledError(正常停)vs 真异常(标记失败、停喂音频、走降级);入站队列满丢帧+计数监控,不无限堆积。
- ✅ **二进制音频子通道**:AIRI 把音频走 SuperJSON 文本是浪费(`crossws/index.ts:76` 拒二进制)——**反证 chat-A 的 PCM Int16 二进制约定正确**;务必从第一天分离"二进制音频通道"与"文本信令通道"。

---

## 3. 架构 / 接缝 / 事件总线 / 可追溯(对应 §3、§8.1、protocol/gateway/runtime)

来源:AIRI、Zerolan、Open-LLM-VTuber、neuro-sdk。

- 🆕 **AsyncLocalStorage 自动传播 traceId 的事件总线**(AIRI `services/minecraft/src/cognitive/event-bus.ts:13,55,77,112,178`)。`TracedEvent{id,traceId,parentId,...}`;订阅者在 dispatch 中再发事件,子事件**自动继承父 traceId 并设 parentId** → 零手工穿线得到完整因果树(感知→信号→决策→动作→反馈)。`deepFreeze` 事件不可变 + 每订阅者 try/catch 隔离。**几乎逐字抄,直接实现 §8.1 关联ID/可重放,最高杠杆。**
- 🆕 **per-handler 超时诊断 + async/sync 双执行器**(Zerolan `event_emitter.py:63-96,119-168,206-216`):每 handler 带 id、记录耗时、超预算**只告警不杀**;协程 handler 与阻塞 handler 分两条执行路径互不拖慢。落地 §3.2"延迟预算"+§8.1"可追溯"于总线本体。
- 🆕 **泛型信封 + action 复用事件名注册表 + correlationId**(Zerolan `zerolan-data/.../protocol/protocol.py:8-17`):`{protocol,version,action,code,data}`,`action`=路由键直接复用进程内事件名常量——**一套命名贯穿 bus/WS/日志/trace**。chat-A 必加 `correlationId`(Zerolan 缺)。
- 🆕 **纯类型 protocol 包:接口映射派生判别联合(无 codegen/无 zod)**(AIRI `plugin-protocol/src/types/events.ts:1295`;`server-shared/.../events.ts:37,41`):`ProtocolEvents<C>` 字符串键→payload 映射,再 `{[K in keyof E]: Envelope<K,E[K]>}[keyof E]` 派生联合,`type` 与 `data` 端到端强关联;`...OptionalSource` 变体作发送类型。这是 chat-A `protocol/` 包样板。
- 🆕 **行为即配置:delivery 策略附着在事件定义上**(AIRI `events.ts:1242,1287`):`defineEventa('input:text',{metadata:{delivery:{mode,group,selection}}})`,路由按事件类型读策略,不靠硬编码 switch。
- 🆕 **epoch 守卫重连 + 双向 liveness**(AIRI `better-ws/src/client/index.ts:295,395,599,708`;`server/index.ts:435`):每次 connect 捕获单调 `connectionEpoch`,异步回调 epoch 不符早返回——修"旧 socket 在新重连后才 resolve"竞态;指数退避封顶 30s+jitter;客户端主动心跳 + 服务端入站静默检测(双阈值)。树莓派↔PC 不稳定链路关键。
- 🆕 **配置 diff 局部重载(只重建变了的接缝)**(Open-LLM-VTuber `service_context.py:324,472-572`):比较旧/新配置,相同则复用引擎,只 teardown+rebuild 变化的。**直接落实 §3.1"模块级重写/爆炸半径可控"+ 热切换**。注意它对 Live2D/MCP 漏做 diff(`:269,294-297`),chat-A 应统一所有模块走 diff。
- 🆕 **判别联合配置池 + `name→子配置 dump() splat` 工厂**(Open-LLM-VTuber `service_context.py:323-345`;`config_manager/asr.py:313-332`):`asr_model: Literal[...]` 选名 + 旁挂 per-provider 子配置。Node 用 zod discriminated union,工厂 `create(cfg.type, cfg[cfg.type])`。比散装能力声明更类型安全。
- 🆕 **能力握手帧(client/provider 上线声明能力)**(Zerolan minecraft `app.py:25-58`:HELLO→FETCH_INSTRUCTIONS→PUSH_INSTRUCTIONS 动态推送 tool schema;Open-LLM-VTuber 服务端 init 序列 `websocket_handler.py:149-176` 主动下发 `client_uid`+`start-mic`)。这是接缝 3"终端能力声明"的跨进程落地;gateway 做边界翻译,**WS 入站消息直接转译成 bus 事件,内部只一套事件机制**(别学 Zerolan WS handler 与事件 bus 双轨)。
- 🆕 **按模型能力自动降级缓存**(AIRI `core-agent/src/runtime/llm-service.ts:267,297`):`TOOLS_RELATED_ERROR_PATTERNS` / `CONTENT_ARRAY_RELATED_ERROR_PATTERNS` 正则,命中后按 modelKey 缓存能力标志并重试。本地/廉价模型常谎报工具支持——树莓派目标下非可选。
- 🆕 **Port 契约 + generation 计数器 + 时钟注入**(AIRI `core-agent/src/contracts/*`;`runtime/chat-orchestrator-runtime.ts:286`):4 个单方法 port 作引擎唯一外部依赖;`session-port` 的 `getSessionGeneration` 单调计数器拒绝过期工作(=chat-A 跨网络 generation 打断的精确机制);注入 `now/createId/monotonicNow` 服务可测试+可重放;可观测性回调从第一天进 deps。
- 🆕 **出站消息 merge 合并 + 双通道发送**(neuro-sdk `MessageQueue.cs:37-40`、`ActionsRegister.cs:27-37`;`WebsocketConnection.cs:189-213`):同类消息发送前折叠去重(省带宽,树莓派弱网值);普通消息走队列+断线重发,**会话收尾消息走 `SendImmediate` 旁路**(帧循环将停时)。
- 🆕 **资源初始化 / 事件接线 / 启动 三层分离**(Zerolan `framework/context.py:34-40`、`bot.py:128-418`):资源生命周期与 `@on` 订阅注册解耦,可单独重写任一层;runnable 注册表 **LIFO 逆序优雅关闭**(`abs_runnable.py:62-83`)。
- ⚠️ **要避开**:Zerolan 类级 `default=str(uuid4())` 所有实例共享同一 id(用工厂函数)、遍历 listeners 时 remove(标记删除)、per-task 随机 uuid 不串链(用 correlationId 继承+causationId)、starter.py/asr_handler 的 if/elif 巨链(用注册表 Map)、硬编码 `version=="1.1"` 相等(做版本协商);Neuro 全局可变 `Signals`+setter 副作用(`signals.py:21-58`)与可追溯冲突——借其中心化 SessionState 的简单,但 setter 改为**发不可变 typed 事件**(这些事件正是 decision trace 数据源)。

---

## 4. 记忆 / 人格 / prompt 组装(对应 §5、§6)

来源:Neuro、AIRI、projectBEA、Open-LLM-VTuber。

- 🆕 **优先级 Injection 的 prompt 组装接缝**(Neuro `llmWrappers/abstractLLMWrapper.py:42-101`、`injection.py:1-19`、`memory.py:30-52`、`customPrompt.py:14-29`)。每模块实现 `get_prompt_injection()→{text, priority}`,按 priority 升序拼(高优先级靠近末尾=最近注意力),拼到 90% context 预算就从最旧历史裁剪,拼完调 `cleanup()` 清一次性状态。**人格(OCEAN)/情绪(PAD)/记忆 RAG/时间情境全变成带优先级、可插拔、可清理的 contributor**,而非硬编码巨型模板——完美契合接缝化+模块化+人格用户自定义+行为即配置。
- 🆕 **KV-cache 稳定性规则(prompt 组装)**(AIRI `core-agent/src/messages/context-prompt.ts:30`;`compaction.ts:100`;`projection.ts:139`):系统提示+人格前缀**字节级稳定**供 KV 复用;volatile 上下文(id/时间戳)只以**扁平 `[Context]\n- id: text` bullet 追加到最后一条用户消息**;**小模型(8B/14B)别用 `<context>` XML 标签**(会被回吐,issue #1539);时间用每消息 `[HH:MM]` 前缀+系统提示日期锚点。来之不易,直接服务树莓派延迟预算。上下文压缩用可注入摘要器(摘要落成 long_term 记忆行=补巩固环节)。
- 🆕 **Reflection 记忆 + 加权召回 + 上下文窗口拼接**(Neuro `modules/memory.py:30-103`;projectBEA `memory_skill.py:104-164`;AIRI `services/telegram-bot/src/models/chat-message.ts:87-149`)。① 反思:每攒 N 条让 LLM 蒸馏"最显著 Q&A"存回向量库(P0/P1 可跑的 3 层记忆雏形);② 召回:over-fetch 后 **similarity×0.7 + recency×0.3** 加权重排(伴侣"最近的事记得更牢"),chat-A 应把衰减换成指数 `exp(-Δt/τ)` 并折入 importance/emotional_impact/access_count;③ **命中后额外取前后各 5 条拼成连贯窗口**(连贯回忆 vs 零散片段);④ 反思生成在**会话结束异步**、`entry_exists("diary_{sid}")` 幂等去重。
- 🆕 **3 层记忆 schema 带评分列 + 多宽向量列**(AIRI `services/telegram-bot/src/db/schema.ts:110`):`memory_type∈{working|short_term|long_term|muscle}`,`importance 1-10`/`emotional_impact -10..10`/`access_count`/`last_accessed` 评分列;三宽向量列 `content_vector_1536/1024/768` 各带索引,**运行时按 `EMBEDDING_DIMENSION` 选列 → 换 embedding 模型不改 schema**(直接服务接缝 7)。
- 🆕 **可组合装饰器流水线做 3 层过滤**(Open-LLM-VTuber `agent/transformers.py`:`sentence_divider→actions_extractor→display_processor→tts_filter`)。chat-A "3 层过滤"的实现方式=每层 async generator transform,职责单一可单测。含 `<think>` 块"显示加括号、TTS 置空"(`:135-140,189-190`)。
- 🆕 **Unicode 类别白名单的 TTS 文本清理**(Open-LLM-VTuber `utils/tts_preprocessor.py:95-138`):NFKC 归一后只留 `\p{L}|\p{N}|\p{P}|\s`,比删 emoji 正则稳健(天然处理所有符号);括号配平剥 `*..*/[..]/(..)/<..>`,各项 config 开关控制。情绪标签映射来自**角色/模型元数据**而非硬编码(`live2d_model.py:48-51`)——人格自定义时情绪→表情映射是人格配置一部分。
- ✅ **人格:card-as-config 但无 OCEAN/PAD**(AIRI `packages/ccc/src/define/card.ts:72`,人格是纯文本;情绪 9 值离散枚举只作表达通道)。**chat-A 数值人格领先**;借 card-as-config 打包形式(`PersonaCard{ocean,pad,systemPromptText,greetings,examples,bindings:{llm,tts,embed}}`),把数值 OCEAN/PAD 渲染进系统提示(数值→形容词)、连续 PAD 映射到最近离散情绪供 TTS/表情表达。注意 AIRI 的 `core-character`/`memory-pgvector` 是空壳,真实现散在 telegram-bot/stage-ui,衰减是线性且评分只用 sim+recency(列存了没用)——别以为抄来就完整。
- ⚠️ Open-LLM-VTuber `handle_interrupt`(`basic_memory_agent.py:202-206`)两分支代码相同且把"用户打断时听到的话"塞 assistant 角色=语义混乱;打断 partial 直接丢弃不入库;配置无版本/迁移。chat-A 打断入库要明确区分"AI 已说出部分"与"用户插入的话",且配置/记忆都带 version+migrate(§3.2 数据迁移纪律)。

---

## 5. autonomy / 行为层(对应 §7)

来源:projectBEA、AIRI、Neuro。

- 🆕 **通用 `SkillScheduler` + `BaseSkill` 后台技能框架**(projectBEA `skill_manager.py:79-102`、`base_skill.py:34-65`)。单循环每 1s reconcile 多技能(`enabled&&!active→start`/`!enabled&&active→stop`/`active→update`);技能不持 timer 只暴露快返回的 `update()`;**`enabled` 每 tick 现读 config**(getter,非缓存)→改 config/调 API 下一 tick 即生效无重启;生命周期四钩子 `initialize/start/stop/update/onConfigReload`;per-skill inflight 锁。**把 autonomy 从"单一 Monologue 循环"升级为可插拔技能框架**(主动跟进/反对/情绪姿态各一 skill),启停纯配置驱动、爆炸半径可控、默认可关——直接命中模块化+行为即配置。
- 🆕 **统一 `requestSpeak()` 输出仲裁 + 单一 `is_speaking` 硬闸 + 打断 resumeBuffer/backchannel 续播**(projectBEA `minecraft_skill.py:48-81`、`brain.py:169-247,249-332,341-352`)。所有后台技能"想说"走同一入口,brain 据忙闲决定真说/记 history 待续/丢弃,persona guardrail 插这层;打断保存剩余语音,用户回 backchannel("继续/嗯")时续播。chat-A 应把"靠各技能自觉查 is_speaking"**升级为显式输出仲裁器**(优先级/抢占),为"会反对、会插话、情绪占用通道"打基础。
- 🆕 **自激内在生活 + no-action 预算节流 + 单消费者优先级事件队列(别用 setInterval)**(AIRI `services/minecraft/src/cognitive/conscious/brain.ts:1463,1568,1721,2145,233,794`;`cognitive/index.ts:90` tick 故意空)。autonomy loop=单消费者优先级队列(语音=URGENT/无聊计时器/记忆唤起/情绪漂移=PERCEPTION/"要不要主动开口"=最低优先级预算受限自跟进);一轮没产出动作就塞合成事件"再想一次"但扣预算(默认 3),用户开口重置预算并 `coalesceQueue` 丢弃排队的自言自语。**"有内心独白但不刷屏/不空转"最干净的旋钮。**
- 🆕 **给模型一个"沉默"工具 + 衰减概率"要不要插话"governor**(AIRI `agents/spark-notify/handler.ts:264`:内置 `builtIn_sparkNoResponse`/`builtIn_sparkCommand` 让 LLM 自己决定要不要回应,系统提示明说"不必回应每个 notify";`attention-handler.ts:5`:被提及+100/触发词+50/空闲衰减,`Math.random()<rate` 掷骰)。PAD 可驱动 base rate(高唤醒/外向→更高回应率)。
- 🆕 **错误突发熔断 + LLM 调用超时/分类重试**(AIRI `brain.ts:936,544`;`llmlogic.ts:143`):5 回合 3 错→强制"放弃并解释";每次 attempt 套 AbortController+60s;纯函数错误分类(限流→指数退避带 jitter,鉴权/参数错→立即抛)。直接服务优雅降级。
- 🆕 **决策上下文聚合 + 防幻觉**(projectBEA `mc_agent/core/agent.py:494-548`):喂决策 LLM `state+recent_events[-5:]+action_history(10)+current_plan`;**上一步 FAILURE 注入"CRITICAL: LAST ACTION FAILED"**强制不假设成功;`current_plan` 可建模"未了话题跟进"。
- 🆕 **多输入 debounce 聚合窗口 + "说话期间偷听到的"**(projectBEA `brain.py:450-556`,`BUFFER_WINDOW=0.3s`):多人同时说话合并成一次 LLM 调用;把打断期间 `pending_transcripts` 作 `[While you were talking, you overheard:]` 前缀注入——让伴侣"知道你刚打断时说了啥"。
- 🆕 **PATIENCE 主动开口最小实现 + 触发策略与"如何回应"分离**(Neuro `prompter.py:17-65`,独立线程每 0.1s 跑 `prompt_now()`,无人说话超 60s 主动找话;Zerolan `bot.py:112-116` SecondEvent 心跳=主动性第一类事件源)。把"何时回应"抽成独立 `TurnPolicy.shouldSpeak(state)`,受 OCEAN(外向)/PAD(唤醒)/时段调制。
- ⚠️ **核心局限=chat-A 的超越空间**:这些项目的自主性**全是定时器触发,从不评估"此刻开口是否值得/用户会不会烦"**(projectBEA Monologue `monologue.py:63-65` 到点就找话题硬讲,决策 LLM 只回答"讲什么"不回答"该不该说")。chat-A 的 `决策 LLM(silent|speak|idle) + 三道节流(每日上限+动态cadence+inflight锁)` 把"是否值得说"作为**一等决策**,是质的超越。隔离别靠约定(单 `is_speaking` 布尔无优先级/抢占),要显式仲裁器。AIRI 的 isolated-vm 每回合 fork 跑 LLM 写的 JS=过度工程+延迟杀手,用结构化 JSON 工具调用即可。

---

## 6. 测试 / 工程化(对应 §3.2 可测试性)

- 🆕 **Randy 双端口测试桩 + schema-faker 模糊 + 显式"不模拟"清单**(neuro-sdk `Randy/index.ts:11-16,40,47-55`,README `:3-7`)。WS 口供 runtime 连 + HTTP 控制口让测试用例**主动注入任意"模型行为"**(主动话题/打断/调工具);`json-schema-faker` 模糊工具参数测 validate 健壮性;再做"恶意桩"发非法 JSON/越权调用(对抗测"会主动会反对")。**Node 几乎照抄,是 chat-A 可测试/可重放/优雅降级的测试地基。**
- 🆕 **有状态/单线程约束的 Provider 用"命令队列+单 owner 循环"**(Neuro `module.py:11-30`、`vtubeStudio.py:159-235`):音频设备/avatar SDK/串口/GPIO 封装成命令队列,外部只入队。树莓派访问硬件外设适用。
- 🆕 **WS URL 三级回退发现**(neuro-sdk `WsUrlFinder.cs:15-19` + `Web Game Runner/server.py:12-26`):连接地址按"启动参数→配置文件→环境变量"分级回退,单一构建在树莓派+浏览器端通用。

---

## 附:仓库与精读文件索引
见 `reference/github-projects/neuro-ecosystem/README.md`。关键文件:
- 官方协议:`neuro-sdk/API/SPECIFICATION.md`、`Randy/index.ts`
- 打断/延迟:`RealtimeVoiceChat/code/{speech_pipeline_manager,transcribe,turndetect,audio_module,text_context}.py`
- TS 同栈:`airi/packages/pipelines-audio/src/{speech-pipeline,processors/tts-chunker,llm-streaming-control/controller}.ts`、`airi/services/minecraft/src/cognitive/event-bus.ts`、`airi/packages/core-agent/src/{contracts,runtime,messages}`
- 能力降级/装饰器:`Open-LLM-VTuber/src/open_llm_vtuber/{agent,service_context,utils/tts_preprocessor}.py`
- autonomy:`projectBEA/src/modules/skills/`、`projectBEA/src/core/{brain,events}.py`
- 总线/契约:`ZerolanLiveRobot/event/event_emitter.py`、`zerolan-data/src/zerolan/data/protocol/protocol.py`
- prompt 组装/reflection:`Neuro/llmWrappers/abstractLLMWrapper.py`、`Neuro/modules/memory.py`、`Neuro/prompter.py`
