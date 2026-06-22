# 记忆框架深读发现:mem0 / Letta / OpenMemory / Memoripy(2026-06-22)

> 方法:克隆四框架到 `reference/github-projects/memory-frameworks/`,逐文件精读真实代码,对照 chat-A §5。
> 标注:🆕=应纳入 | ✅=确认 | ⚠️=订正/坑 | ⛔=避开。公式取自真实代码 file:line。

## 0. 头条订正(round-1 `reference-projects-research` 已过时)
- ⚠️ **mem0 v2.0.7(commit 29d131f)已废弃 ADD/UPDATE/DELETE/NOOP 写路径**:现为 **ADD-only 加性抽取 + MD5 哈希去重 + LLM 侧 `linked_memory_ids`**(`mem0/memory/main.py:798-937`;系统 prompt 明文 "Your sole operation is ADD" `configs/prompts.py:468-472`)。`get_update_memory_messages`/`DEFAULT_UPDATE_MEMORY_PROMPT` 全零调用、遗留死代码。**原因:LLM 决定 update/delete 误删率高,故意退回加性。**
- ⚠️ **OpenMemory 衰减 λ 三档**(hot/warm/cold = 0.005/0.02/0.05,`memory/decay.py:23-25,42-48`)非固定 0.02;真实检索打分 `0.35·boosted_sim+0.20·token_overlap+0.15·waypoint+0.10·recency+0.20·tag` 过 sigmoid(`memory/hsg.py:258-266`),round-1 的 `0.6·sim+0.2·sal+0.1·rec+0.1·link` **不存在于实际 hsg_query**;无 `emotion_snapshot/significance` 列,情感 = `primary_sector='emotional'` 扇区 + `salience` 字段。
- ⚠️ **Letta 摘要触发 90%**(`SUMMARIZATION_TRIGGER_MULTIPLIER=0.9` `constants.py:83`),"70%" 实为保留 30%/驱逐 70%(`settings.py:86`);sleep-time = 回合取模触发的 **fire-and-forget 后台 task**(`groups/sleeptime_multi_agent_v2.py:114-120,249`)。
- ⚠️ **mem0 OSS 无衰减实现**(`timestamp/decay` 参数被 `raise ValueError`,`main.py:702-703`,platform 专属);**无 Neo4j**(spaCy 抽实体 + `linked_memory_ids` 共现)。

## 1. 召回打分 / 写路径(mem0 + Memoripy)
- 🆕 **关键词分自适应 sigmoid 归一**(mem0 `utils/scoring.py:31-54`):`kw_norm=1/(1+exp(-s·(raw-m)))`,`(m,s)` 按 lemmatized 词数 `{≤3:(5,.7),≤6:(7,.6),≤9:(9,.5),≤15:(10,.5),>15:(12,.5)}`。SQLite FTS5 `bm25()` 同样无界,直接套压到 [0,1]。
- 🆕 **自适应分母归一**(`scoring.py:97-119`):`combined=min(Σsignals/max_possible,1.0)`,信号缺席分母自动缩小(无 PAD/无关键词时不稀释)。比固定权重和稳。
- 🆕 **抗幻觉整数 ID 映射**(`main.py:815-820`):双 Pass 把旧记忆喂 LLM 对标时用临时序号 "0/1/2" 而非真 UUID,回映后落库——降 LLM 张冠李戴。
- 🆕 **实体 boost 热门降权**(`main.py:1657-1658`):`weight=1/(1+0.001·(n-1)²)`,被越多记忆链接的实体单条 boost 越小,防霸屏。`ENTITY_BOOST_WEIGHT=0.5`。
- 🆕 **Memoripy 乘性 use-it-or-lose-it**(`memoripy/memory_store.py:112-134`):命中 `decay_factor×1.1`+access+1+timestamp 刷新;未命中(进池未过阈值)`×0.9`。比 chat-A "召回+0.15封顶1.5" 更接近"用进废退"。
- 🆕 **Memoripy spreading activation**(`memory_store.py:158-181`):概念图 2 跳,`new=activation·0.5·edge_weight`,加性叠加到语义分。边权=共现次数。
- ⚠️ **mem0 语义门控会硬丢低分项**(`scoring.py:111-112`):`semantic<threshold` 直接排除,关键词/实体救不回——**与 chat-A "情感共振也是召回信号"的加性哲学冲突**,照抄会丢"语义不相关但情感强共振"的记忆(陪伴核心)。chat-A 的门控应只对"无任何信号"生效。
- ⚠️ **Memoripy 衰减秒级且复利写回**(`memory_store.py:85,100-101`,`rate=0.0001/秒`半衰~1.9h,每次召回再乘写回)——勿照抄数值;chat-A `0.5^(days/H)` 惰性实时算、不写回更健壮。Memoripy 无去重/矛盾消解(纯 append),不适合长期伴侣。

## 2. 分层 / 巩固 / 衰减(Letta + OpenMemory)
- 🆕 **salience 进衰减分母 + 热度分层 λ**(OpenMemory `decay.py:152-154`):`sal=clamp(sal·(1+log1p(coactiv)))`;`f=exp(-λ_tier·dt_days/(sal+0.1))`;`new_sal=clamp(sal·f,0,1)`。高 salience 衰减更慢、热度定 λ 档。chat-A 保留 `0.5^(d/H)` 为 base,借此让 H 随 salience/热度变。
- 🆕 **检索即强化 + 沿图传播**(OpenMemory `ops/dynamics.py:38-53`,`hsg.py:607-625`):命中 `new_sal=sal+0.18·(1-sal)`;邻居沿 waypoint `ctx_boost=0.2·(rsal-neighbor)·exp(-0.02·Δdays)`。"用得多/被联想→记得牢"。⚠️ OpenMemory 有 bug(`decay.py:206-207` 双赋值、`hsg.py:586` 键重复)——借公式别照搬。
- 🆕 **跨扇区共振矩阵**(`ops/dynamics.py:17-31`):5×5 `SECTORAL_INTERDEPENDENCE`,`score=base_sim·M[mem_sec][query_sec]`(emotional↔episodic=0.7、emotional↔semantic=0.4)。把 chat-A "情感共振" 落成 O(1) 查表。
- 🆕 **boosted_sim + tag_match + sigmoid**(`hsg.py:258-266`):`boosted_sim=1-exp(-3·sim)`(放大中段相似度区分),显式 `tag_match`(0.20),末端 sigmoid 归一。
- 🆕 **SimHash 写入去重**(`hsg.py:165-198`):64-bit SimHash,汉明距≤3 视重复 → 旧记忆 `salience+0.15` 而非新建。防记忆膨胀(长期伴侣关键)。
- 🆕 **OpenMemory 反思巩固结构**(`memory/reflect.py:92-125`):定时(默认 10min)取 100 条 → 同扇区+Jaccard>0.8 聚类 → 每簇≥2 生成 reflective 记忆 + 源 `×1.1`。⚠️ 其 `summ()` 是纯模板拼接非 LLM(质量低)——chat-A 用 LLM 蒸馏替换,保留"聚类→共识→提升源 salience"结构。
- 🆕 **Letta 90%/30% 确定性数字**(`constants.py:83`,`settings.py:86`):压缩触发 90% context、保留 30%——确定性阈值/比例可借鉴(避免 LLM 决定何时压缩),但 **chat-A 放后台**。
- 🆕 **Letta core memory block schema**(`orm/block.py:38-50`):`label/value/limit/read_only/hidden`,每回合 `Memory.compile()` 渲染进 `<memory_blocks>` XML——对应 chat-A "核心常驻 pinned" 的块化形态。

## 3. ⛔ 明确避开
- **Letta agentic 工具调用自管记忆**(`core_memory_append/replace`、`archival_memory_*` 全 LLM 决定何时调,`tool_executor/core_tool_executor.py:278-344`):每次读写 LLM 推理+工具往返,**对实时语音致命**。chat-A 确定性打分管线是对的,勿退回。Letta 自己把整理移到 sleep-time。
- **Letta 前台同步摘要**(`agents/letta_agent_v3.py:1439` step 内触发 LLM 摘要阻塞响应)→ chat-A 巩固/压缩全部后台。
- **OpenMemory SQLite 全表扫描余弦**(`core/vector_store.py:67-89` 无 ANN,逐行 numpy)→ chat-A 用专门向量库,SQLite 只做真相源+FTS+元数据/衰减。
- **OpenMemory 双套不一致衰减/打分**(后台 `decay.py` vs 检索 `hsg.py` 两套公式漂移;简单 `scoring.py` 0.6/0.2/0.2 vs HSG 五项并存)→ chat-A **单一权威公式**(承 §3.2 行为即配置)。
- **mem0 LLM 决定 update/delete**(已被 mem0 自己废弃)→ chat-A 写路径热路径 ADD+去重,update/delete 留离线 Reflection。

## 最值得加进 §5 的(优先级)
1. 写路径:热路径 ADD+SimHash 去重,update/delete 移离线 Reflection(避 LLM 误删)。
2. 关键词分自适应 sigmoid 归一 + 自适应分母(无信号不稀释)。
3. salience 进衰减分母 + 热度分层 H(重要/常访问记忆衰减更慢)。
4. 检索即强化 + 沿图传播(或 Memoripy 乘性 ±10%)。
5. 跨扇区情感共振矩阵 + boosted_sim + SimHash 去重。

## 关键文件
- mem0:`mem0/memory/main.py`(写 798-937 / 检索 1488-1586)、`mem0/utils/scoring.py`、`configs/prompts.py:468`。
- Memoripy:`memoripy/memory_store.py`(打分 97-181)、`memory_manager.py`。
- Letta:`letta/orm/{block,passage,archive}.py`、`services/tool_executor/core_tool_executor.py`、`services/summarizer/`、`groups/sleeptime_multi_agent_v2.py`。
- OpenMemory:`core/{constants,db,vector_store}.py`、`memory/{decay,scoring,hsg,reflect}.py`、`ops/dynamics.py`、`migrations/001_initial.sql`。
- 源码克隆见 `reference/github-projects/memory-frameworks/`(README 索引)。
