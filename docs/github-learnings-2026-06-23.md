# GitHub 类似/相关项目可学习清单 → chat-A（2026-06-23）

> 5 路并行 GitHub 调研汇总(语音陪伴/VTuber、实时语音管线、端侧+主动性、人格情感角色扮演、Agent 记忆框架)。已排除已深研的本地参考(Neuro/Nexus/Open-LLM-VTuber/AIRI/Zerolan/LingYa/eros_ai/mem0-Letta-Zep 旧调研)。[V]=一手核实 README/论文 / [I]=推断。语音管线(§4)细节见 `voice-pipeline-findings-2026-06-23.md`,本文聚焦 §5/§6/§7/§5.6 + 可测试性。

## 0. 一条必须正视的设计修正(§7 护城河)
**"别人只用定时器、我们评估是否值得开口"的断言已不安全** [V]:**Inner Thoughts(CHI 2025,开源)** 用 8 因子动机量表(关联/信息缺口/预期影响/紧迫/连贯/原创…)→ CoT 权衡 → **双阈值(说 vs 打断)**,几乎与 chat-A §7 一致且已发表;**ProactiveAgent**(学习型奖励模型 + False-Alarm 分类 + 反馈防刷屏)、**Proact-VL**(微软实时陪伴,自主决定何时/多久/语速)同向。
→ **§7 应改措辞**:引用 Inner Thoughts 为思想前身;可防守差异化**收窄为组合**——决策 LLM + **三道**节流 + **跨会话持久内在生活** + **会反对/不服从** + 可插拔 SkillScheduler + no-action 预算优先级队列(无单一项目集齐)。**§7#1 内在生活 + open-thread 跟进 + 会反对**仍是真实蓝海。

## 1. §5 记忆:值得引入的算法点(均可落 §5 既有接缝、不引服务级组件)
1. **[V] HippoRAG 2 的 PPR 联想扩散 = 升级"联想扩散"的正解(最高价值)**:§5.7c 已列"A-MEM 式邻接 + 1-2 跳"待升级。**抄 HippoRAG 的 PPR 而非 LightRAG 的一跳**:SQLite 小实体邻接图(边 = 共现 + **你已有的 sqlite-vec 语义近邻**——天然替代 HippoRAG 昂贵的 O(n²) 同义边预计算,是你已持有的胜势),query 命中实体做种子跑稀疏 PPR(`r=(1-α)·M·r+α·s`,十几次迭代),单用户几千节点树莓派单位数毫秒。放非阻塞快路径之外做增强(§5.5 硬约束)。
2. **[V] Nemori predict-calibrate 惊奇编码**(§5.7c 已标待升级):预测(由已有语义记忆预测本情景)→ 校准(对比原文找 prediction gap)→ 只蒸馏 gap 入语义。**放夜间 dream pass**(有 LLM 预算),非 Nemori 在线方式。其 LLM 连贯/意图漂移分段 + buffer 上限 25 条 = §5.5 夜间事件分割现成配方。
3. **[V] Letta sleep-time compute = 夜间巩固的工业级证明**(arXiv 2504.13171):主体活时**只读**记忆无编辑工具,睡眠体异步重写;同准确率 test-time 算力 ~5x↓、巩固后准确率再 +13-18%。两条落地:① **读写分离纪律**(热路径只读,重写离关键路径 = §5.5 非阻塞 + §5.8 离线调和)② **整块重写**(增量打补丁产生"脏"记忆,改为重生成 clean summary → §5.7d 夜间应**重生成**蒸馏摘要而非外科编辑)。
4. **[V] Mem0 v3 回退 ADD-only 验证 §5.8**:2026-04 明确"单次 ADD-only 抽取,无 UPDATE/DELETE,期望改写的代码必须重构";官方理由是效率+准确率+延迟(LoCoMo +20、延迟减半),"误删率"是社区解读 [I]——但结果完全印证 §5.8 ADD+去重热路径。
5. **[V] Mem0 v3 / 原 MemoryScope:BM25/实体仅作 re-rank boost、不扩召回**:向量为主候选池,FTS/实体作归一加权重排——与 chat-A **加权 min-max 融合天然契合,印证不上 RRF 是对的**。
6. **[V] Graphiti 确定性 IR 去重前置**:LLM 去重前先 精确匹配 → MinHash/LSH(3-gram,Jaccard>0.9)候选 → 熵门 + LRU 缓存 shingle。直接强化 §5.8 ADD+去重:LLM 前加 LSH 预筛,降本降方差。
7. **[V] MemoryScope 的 LLM 矛盾判定→EXPIRED(状态式遗忘)**:相似节点对 → LLM 判矛盾/冗余/无关 → 置 EXPIRED(召回过滤非物删)。§5.9 时间衰减之外的**互补遗忘**,全离线、合夜间巩固 + 保守删(§5.8)。
8. **[V] txtai = 端侧检索底座参照手册**:唯一一手支持 **sqlite-vec** 的活跃框架,默认本地栈 SQLite+sqlite-vec+NetworkX 单文件离线;零依赖无 torch 路径、faiss mmap 降 RAM、sqlite-vec 1/8-bit 量化 = §5.6/§5.9 端侧 cookbook。
9. **[V] Memobase 配置化 profile 槽位 + 每槽合并策略(人物层,伴侣场景最相关)**:唯一 companion 定位框架(`profile_for_companion`),topic→sub_topic→content 槽位经 config 可配,每槽附自然语言 "update 策略"(名字覆盖 vs 兴趣累积);**profile 无需 embedding(结构化召回),只有事件用向量**——印证"不是什么都要向量"。引入 §5.3b 人物花名册:配置化 profile 槽 + 每槽合并策略。

## 2. §6 人格情感:可移植积木
1. **[V] EmotionEngine 情绪弹簧数学**:当前 PAD 点被各活跃情绪按距离施力拉拽、无强化时衰减回归 OCEAN 派生基线——chat-A "心情弹簧/冷启动回归基线"的现成实现((intensity, decay_rate, influence_radius) + spring-toward-target)。
2. **[V] npc-neural-affect-matrix**:OCEAN 设 resting PAD 点并偏置 appraisal;每条交互按 `{source_id, valence, arousal, time}` 存 + 时间衰减——同时命中 §6(OCEAN→PAD)和 §5.3b("谁说的"+来源衰减)。
3. **[V] FAtiMA OCC 22 情绪 appraisal**:学术参考实现(事件→Desirability/Praiseworthiness→离散情绪 + Emotion/Mood/Personality 三层),可与 chat-A LLM-driven Appraiser 互补/对照。
4. **[V] affective-bridge:情绪外化为结构变量 + 原型防漂移**:别让情绪只活在 prompt,推到外部 VAD 结构变量 + "情感原型"反漂移校准——补 chat-A Appraiser 下游。
5. **[V] character-card-spec-v3 @@decorators**:配置即文本指令(@@depth/@@role/@@position…),不扩 schema 即加能力;chat-A 数值人格为结构化主干,decorator 仅作受控行为旁路。
6. **🆕 [V] 关系亲密度慢变量 = chat-A 潜在缺口**:MeuxCompanion(trust/affection/mood/energy 随互动演化)+ digital-companion-core(三层记忆带 emotional_weight)显式建模"对主用户的关系状态"。chat-A §6 有人格+PAD 情绪,但**陌生→熟悉→信任的关系亲密度慢变量未显式建模**——这是"长期伴侣"北极星的关键。建议 §6 增设轻量"关系状态"会话级标量。

## 3. §7 行为/主动性:可移植积木
1. **[V] Inner Thoughts 8 因子动机量表 + 双阈值(说 vs 打断)**:直接喂 chat-A 决策 LLM prompt 与三道节流。
2. **[V] ProactiveAgent 奖励模型 + False-Alarm/Missed-Needed 分类法**:作 autonomy 的 **eval 框架** + 反馈式节流衰减(被忽略→后续少提议);学习型 gate 可与 LLM gate 互补。
3. **[V] FutureSpeakAI 反谄媚熔断器(§7#3/#6,开源蓝海)**:同意连击≥8 + 正向偏置 EMA≥85% 双触发 → 重置降 warmth/humor;**主动性安全下限 0.3**(再安静也"重要的事永远会开口")。接 appraisal/PromptContributor 接缝。
4. **[V] PersonaForge Generate-Delete-Rewrite / Echo-Mode detect-repair**:加独立"是否符合人设 & 是否谄媚"校验 pass(PromptContributor 之后的独立 seam),对 off-brand 输出删除-改写。
5. **[V] GLaDOS:<600ms 对话延迟硬目标 + 打断时把被截断半句写回历史**:chat-A §4 应吸收(打断不只停 TTS,还记"我话说到一半被打断了"供记忆/情绪);Society-of-Mind 多 agent 拼 context ≈ §5.4 PromptContributor(架构验证)。
6. **[V] Live2DPet 屏幕情境 → 主动开话题**:PC 档主动性新事件源(嵌入式 profile 关掉);隐私:本地 VLM 优于截图传 API。

## 4. §5.6 端侧:可移植积木
1. **[V] `compute_type` 做成 per-profile 旋钮**(量化绑 profile 非 backend):RK3588=w8a8(无 int4)/ Jetson=int4 AWQ-GPTQ / Pi-PC=int8/float16/Q4_K_M。Willow(Pi int8)/Xiaozhi(C3/S3/P4 分级)活体印证。
2. **[V] 未来端侧 LLM target 全藏 Provider 接缝后**:`--target rk3588`→rkllama(OpenAI 兼容)/ jetson→vLLM-Ollama / raspberry→llama.cpp llama-server-Ollama;DeepSeek 已 OpenAI 风格,切换近零成本。
3. **[V] Wyoming `describe`→`info` 能力握手 + 流式 chunk 词汇**作进程内 factory 契约(跳过其多进程 TCP——生态自己已把 satellite 移出 Wyoming 降开销);discriminated-union backend 暴露 `capabilities()` 让运行时按 profile 校验。
4. **[V] Mycroft 反模式入宪**:绝不让任一组件(尤其远程)成为不可降级依赖(Mycroft 死于云依赖不可降级 + 排斥 local-first + 专利);OVOS 靠插件化分解存活——印证 chat-A local-first + 可选云 + 模块可重写。
5. **[V] sherpa-onnx 统一兜底**:STT+TTS+VAD+唤醒同一 Apache ONNX 运行时,RKNN/QNN/Jetson NPU。

## 5. 可测试性(回归测试反谄媚 + 人格稳定,现成指标)
- **[V] SYCON-Bench**:Turn-of-Flip(施压几轮才弃守立场)/ Number-of-Flips(立场不稳次数)——做成 dashboard 证明"小雪会反对"。
- **[V] lechmazur/sycophancy**:对立叙述者配对(同时偏袒双方=谄媚)+ Contrarian rate(防矫枉过正"为反对而反对")。
- **[V] likenneth/persona_drift**:跨 8+ 轮探针问题检测人设滑坡,做长会话人格回归测试(split-softmax 推理级干预仅自托管可用,闭源 API 不适用)。

## 6. chat-A 已确认领先全场(应坚持、勿回退)
- **数值演化人格**:主流伴侣框架(Open-LLM-VTuber/airi/Neuro/aituber-kit/RisuAI/SillyTavern/Agnai)几乎都把人格当 system prompt/角色卡文本,**零 OCEAN→PAD 数值演化、零弹簧、零防漂移/反谄媚**;唯二数值类比(digital-companion-core/Aether)也无公式/无 PAD/无衰减。
- **反谄媚 = 开源蓝海**:大牌伴侣框架全无;真正工程只散落小型/研究 repo。
- **SQLite 真相源 + sqlite-vec 单轨**:13 个记忆框架里唯 txtai 一手支持 sqlite-vec,其余全假设服务级库(Neo4j/ES/Qdrant/pgvector)或仅 JSON——单文件嵌入式全场最强端侧契合。
- **非阻塞首字延迟硬约束**:无一框架为语音延迟保证检索不阻塞首字(多数把 LLM 放写/取路径)。
- **情绪一致软重排**:全场无任何框架有情感/心情偏置召回——chat-A 独有。
- **主语化记忆/人物花名册(§5.3)**:多为 lorebook 关键词/泛 RAG,少有"谁说的/我是谁";夜间还写第一人称自传记忆为各框架所无。
- **加权 min-max 归一融合(非 RRF)**:有先例(MemoryScope/Mem0 boost)、可调、认知保真,无人有明显更优解。
- **三道节流 + no-action 预算 + 单消费者优先级队列**:比所有在产伴侣项目更有纪律(仅 ProactiveAgent 有显式防刷屏)。

## 7. 候选设计更新(待用户逐条定夺)
1. **§7 改措辞**:引用 Inner Thoughts/ProactiveAgent/Proact-VL 为前身,差异化收窄为组合(见 §0)。
2. **§6 增"关系亲密度"会话级慢变量**(trust/亲密度,陌生→信任演化)。
3. **§7#3 反谄媚增"同意连击熔断器 + 主动性安全下限 0.3"**;加独立"人设/谄媚校验改写 pass"。
4. **可测试性:引入 SYCON-Bench ToF/NoF + persona_drift 探针**作反谄媚/人格回归指标。
5. **§5.7c 联想扩散升级路线锁定为 PPR(HippoRAG 式,SQLite 稀疏矩阵)**,非固定跳。
6. **§5.7d 夜间巩固:Nemori predict-calibrate 惊奇编码 + Letta 式读写分离/整块重写纪律 + Graphiti LSH 去重前置**。
7. **§5.6:`compute_type` 升为 per-profile 旋钮;端侧 LLM target 藏 Provider 接缝(OpenAI 兼容);Mycroft 反模式入宪**。
8. **§5.3b 人物层:引入 Memobase 式配置化 profile 槽位 + 每槽合并策略**。
9. **§6 情绪弹簧:对照 EmotionEngine 校核现有弹簧数学**(可能已等价,作验证)。
