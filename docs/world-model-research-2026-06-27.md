# 世界模型（World Model）调研

**日期**: 2026-06-27 | **目的**: 为 chat-A（小雪）储备世界模型理论知识，评估其对陪伴 Agent 的实用价值

---

## 一、一句话定义

**世界模型**是智能体内部构建的环境生成模型，使其无需直接与真实世界交互，即可模拟"如果……会怎样"的未来推演（counterfactual rollout），从而进行预测、规划和决策。

对小雪而言：她需要的不是物理世界模型，而是**社会世界模型**——建模用户的心理状态与小雪-用户的关系动态，支持反事实推断，在快反应（System 1）与慢思考（System 2）之间切换。

---

## 二、核心论文与系统摘要

### 2.1 Ha & Schmidhuber, "World Models" (2018, NeurIPS)

**核心思想**：将感知、动态预测、控制三者解耦训练。控制器可完全在"梦中"训练，零真实环境交互即可迁移。

| 组件 | 功能 |
|------|------|
| **V (VAE)** | 将 64×64 原始画面压缩为 32 维潜向量 z |
| **M (MDN-RNN)** | LSTM + 混合高斯，预测下一潜状态 P(z_{t+1} \| a_t, z_t, h_t)，隐藏态 h_t 含速度等时态信息 |
| **C (Controller)** | 线性策略 a_t = W_c [z_t; h_t] + b_c，用 CMA-ES 进化策略训练（仅 867 参数） |

**关键洞察**：即使未训练的随机 RNN，在 CarRacing 上也能接近最优——RNN 隐藏态本身就是强先验。

**局限性**：仅验证于简单 2D 游戏，未涉及复杂物理/社交/语言。

### 2.2 LeCun, "A Path Towards Autonomous Machine Intelligence" (2022)

**核心思想**：提出以 **H-JEPA**（层级式联合嵌入预测架构）为核心的认知架构——"在表征空间而非像素/Token 空间预测"。

六个可微模块：感知 → 世界模型(H-JEPA) ↔ 行动器 / 短期记忆 / 成本模块 / 配置器

**JEPA 关键创新**：
- 用 VICReg 正则化防止表征坍缩
- 潜变量 z 捕获不可观测因素（多模态未来的不同可能性）
- 支持 Mode-1（反应式，快）和 Mode-2（审慎规划，慢）

**局限性**：迄今主要是位置论文 + 小规模验证（I-JEPA、V-JEPA），未在真实机器人上大规模证实。

### 2.3 DreamerV3 (DeepMind, 2023)

**核心思想**：用**固定超参数**的世界模型在 Atari 到 Minecraft 的多个领域达到 SOTA。首个无需人类数据的 Minecraft 钻石收集算法。

架构：感官输入 → 离散表征 z_t → RNN 序列模型 → 预测未来表征/奖励 → Actor/Critic 在"想象"轨迹中学习。

### 2.4 MuZero (DeepMind, 2019/2020, Nature)

**核心思想**：学习**仅预测"对规划有价值的量"**（价值、策略、奖励）而非重建像素的隐藏世界模型。MCTS 完全在潜空间搜索，无需外部模拟器。

**意义**：证明世界模型不需要重建完整观察——只需学习对决策有用的抽象。

### 2.5 Sora (OpenAI, 2024) — 视频生成式"世界模拟器"

1B-3B 参数扩散 Transformer，通过学习视频时空补丁涌现 3D 一致性、物体持久性。

**关键争议**：LeCun 直言"能生成逼真视频不等于理解世界"。ICML 2025 研究证实 Sora 类模型在分布外物理场景失败，表现为"基于案例的模仿"而非"物理定律掌握"。

### 2.6 Genie / Genie 2 / Genie 3 (Google DeepMind, 2024-2025)

从无标签互联网视频中学习可控的潜在动作空间，生成可交互 3D 世界。

| 版本 | 时间 | 突破 |
|------|------|------|
| Genie 1 | 2024.02 | 11B 参数，2D，从视频学潜在动作 |
| Genie 2 | 2024.12 | 扩散模型，3D 世界，SIMA Agent 执行指令 |
| Genie 3 | 2025.08 | 实时 24fps 生成 |

---

## 三、关键概念术语表

| 术语 | 定义 |
|------|------|
| **World Model** | 智能体内部用来模拟环境动态的生成模型，支持反事实推演与规划 |
| **Mental Model** | 认知科学概念（Craik, 1943）：人类大脑内部对现实的小尺度模拟 |
| **Environment Model** | 世界模型的子集——仅表征**当前**周围状态（3D 空间），不含因果/关系知识 |
| **JEPA** | LeCun 提出的替代方案：在抽象表征空间预测，VICReg 防坍缩 |
| **Latent Space** | 高维观察被编码器压缩到的低维抽象空间 |
| **Rollout** | 从当前状态出发，用世界模型模拟多步未来轨迹 |
| **Planning** | 在世界模型内搜索最优动作序列（MCTS/MPC），System 2 的核心 |
| **System 1 / 2** | Kahneman 双过程理论：S1 = 快速直觉反应；S2 = 慢速审慎推理 |
| **Counterfactual** | Pearl 因果阶梯第三级：回答"如果我做了 X 会怎样" |
| **Social World Model** | 在物理世界模型之上，建模他人的信念、目标、意图、情绪 |
| **ToM** | Theory of Mind——推断他人心理状态的能力 |

---

## 四、开源项目地图

### 4.1 强化学习世界模型（概念源头，对小雪不直接适用）

| 项目 | 仓库 | 特点 | Stars |
|------|------|------|-------|
| **DreamerV3** | github.com/danijar/dreamerv3 | JAX RL 世界模型，固定超参跨域 SOTA | 1800+ |
| **IRIS** | github.com/eloialonso/iris | GPT 式自回归 Transformer 世界模型，ICLR 2023 | — |
| **TinyWorlds** | github.com/AlmondGod/tinyworlds | DeepMind Genie 极简复刻，3M 参数，实时交互 | 1300+ |
| **VideoWorld** | github.com/bytedance/VideoWorld | 字节豆包开源，纯视觉 300M 达围棋五段 | — |

### 4.2 认知架构 / 伴侣 AI（直接相关）

| 项目 | 出处 | 核心机制 | 成熟度 |
|------|------|----------|--------|
| **MATE** | Zenodo, 2026 | 确定性情感中间件：`transition(state, event) → new_state`。Plutchik+PAD+25-30 人格特质+7 维记忆图。67K 行代码/3004 测试，11 用户 63 天部署。Voight-Kampff 基准 84%（所有现有系统 0%） | **高** |
| **CTEM / Auri** | arXiv, CHI 2026 | 跨时间情感建模闭环：过去→情感→当下交互→用户反馈回写。21 天实地研究验证 | **高** |
| **Interaction World Models** | MIT Media Lab | Social-JEPA：潜在交互动力学世界模型，比生成式模型快 1059x-2314x，支持反事实推理 | 中高 |
| **ARIS** | arXiv, 2025 | 图结构社交世界模型+RAG，Pepper 机器人 23 人用户研究 | 中 |
| **LEKIA 2.0** | arXiv, 2025 | 分离认知层和执行层，情境建模与干预执行解耦，~31% 提升 | 中 |
| **The Liminal Engine** | Zenodo, 2026 | 诚实持久人机陪伴框架：破裂/修复建模+仪式引擎+行为立场控制器 | 中 |

### 4.3 记忆系统（直接可用）

| 项目 | 仓库 | 核心机制 | Stars | 许可 |
|------|------|----------|-------|------|
| **Mem0** | github.com/mem0ai/mem0 | 混合向量库+KG 记忆层，自编辑去重 | ~48K | Apache 2.0 |
| **Letta** (MemGPT) | github.com/letta-ai/letta | OS 式虚拟内存：RAM/可搜索/冷存储三层，智能体自主编辑记忆 | ~21K | Apache 2.0 |
| **Memoripy** | github.com/caspermartensson/memoripy | 类人记忆：上下文存储/检索，过滤无关信息降本 | 小 | 开源 |
| **Graphiti** (Zep) | github.com/getzep/graphiti | 双时态 KG（valid_at + recorded_at），追踪随时间变化的事实 | ~24K | 专有 |
| **Hindsight** | — | 多策略混合检索（4 并行路径 + cross-encoder 重排），LongMemEval 94.6% | ~4K | MIT |
| **digital-companion-core** | github.com/Ahmed-KHI/digital-companion-core | **npm 包 / TypeScript**。`Soul` 类：情景/语义/情感三类记忆 + 情感状态引擎 + 身份框架（OCEAN+MBTI+信念+目标+关系） | 6 | MIT |

### 4.4 神经符号 / 知识图谱

| 项目 | 仓库 | 核心机制 |
|------|------|----------|
| **Worlds API** | jsr.io/@fartlabs/worlds | 神经符号基础设施——"智能体的可拆卸海马体"。SPARQL RDF + SQLite + 混合检索（向量+符号+全文）+ RRF 融合 |
| **PyReason** | github.com/lab-v2/pyreason | 广义标注逻辑，模糊+开放世界+时序推理，全可解释 |
| **Veloclade** | github.com/its-not-rocket-science/veloclade | 进化枝启发层次+嵌入聚类的神经符号 KG，MIT 许可 |

---

## 五、对 chat-A（小雪）的实用建议

### 核心判断：小雪需要"伴侣世界模型"，不是"物理世界模型"

### 建议 1：极简用户状态机（优先级最高）

借鉴 MATE 的 `transition(state, event) → new_state` 纯函数模式：

```
UserState {
  mood: { valence, arousal, dominance }     // PAD 三维空间
  activity: "working" | "resting" | "commuting" | ...
  energyLevel: 0..1
  opennessToTalk: 0..1                      // 用户是否愿意深聊
  lastInteraction: timestamp
  sessionCount: number
}
```

- 确定性内核 + LLM 仅负责生成文本。状态机纯函数、可复现、可 golden test
- `digital-companion-core` 的 `Soul` 类 TypeScript 结构可直接参考

### 建议 2：基于记忆的"人际社交图"

借鉴 ARIS + Zep 双时态 KG：

```
节点：用户 / 用户的朋友家人 / 小雪自己
边：KNOWS / LIKES / MENTIONED_IN_CONTEXT / HAS_TRAIT
```

- 用 Mem0 的思路：每次对话后从文本中增量提取原子事实
- 用 Zep `valid_at` / `recorded_at` 追踪事实的时间变化
- 极简起步：内存 `Map<nodeId, { properties, edges }>` + JSON 序列化

### 建议 3：日常规律模型

```
RhythmModel {
  hourlyActivityPattern: number[24][7]    // 工作日/周末每小时说话概率
  avgSessionDuration: number              // 平均每次聊多久
  typicalTopicsByTime: Map<timeSlot, topic[]>
  silenceTolerance: number                // 多久不说话算"沉默"而非"离开"
}
```

- 滑动窗口统计，无需神经网络
- 用于：判断何时主动发起对话（不打扰工作）、理解异常（"你今天这个点居然在线？"）

### 建议 4：情感闭环（CTEM 模式）

```
对话 → 提取情感信号 → 更新内部情感状态 → 影响下一轮语气/话题/主动性 → 用户反馈 → 回写记忆
```

这是 canonical design 中"主动、反对"等性格特质落地的基础——没有内部状态变化，性格就只是 prompt 里的静态描述。

### 建议 5：System 1 / System 2 架构

| 场景 | 系统 | 延迟要求 |
|------|------|----------|
| 日常寒暄、情感确认、简单呼应 | **System 1**（快速直觉式） | < 500ms |
| 深入讨论、提供建议、回忆往事 | **System 2**（慢速审慎推理） | 可接受 2-5s |
| 判断用户是否危险情绪 | **元认知仲裁器**（决定切换时机） | 实时 |

参考 Google DeepMind Talker-Reasoner：Talker 永远在线处理对话，Reasoner 选择性激活。

### 建议 6：反事实社交推理（远期）

Interaction World Models 的 Social-JEPA 思路：在潜在空间模拟"如果这样回，三回合后气氛会怎样？"——作为架构预留接缝即可。

---

## 六、不做推荐（过度设计）

| 概念 | 为什么不适用 |
|------|-------------|
| **DreamerV3 / IRIS / TWM** | RL 世界模型，用于训练游戏 AI/机器人策略。概念可参考，完整引入是南辕北辙 |
| **Genie 2 / VideoWorld / Sora** | 视频生成式世界模型，小雪是纯语音 Agent，无视觉 I/O |
| **MuJoCo / PyBullet / Isaac Sim** | 物理仿真引擎，面向具身智能。完全不相关 |
| **完整 RDF/OWL 知识图谱** | 单用户关系建模不需要本体论推理。属性图完全够用 |
| **MATE 67K 行完整实现** | 设计阶段过重。先走最小可行路径：1 个 PAD 向量 + 3-5 条转换规则 |
| **Hindsight 四路混合检索** | 复杂检索留到记忆系统需要时再考虑 |

---

## 七、最值得跟进的资源（按实用价值排序）

1. **MATE**（确定性情感内核设计哲学 + PAD 建模方法）——核心论文精读
2. **digital-companion-core**（TypeScript `Soul` 类）——同技术栈，代码结构可参考或 fork
3. **CTEM / Auri**（情感闭环学术验证）——为 chat-A canonical §6 情绪闭环提供方法论支撑
4. **Mem0 / Letta**（记忆层成熟方案）——先借鉴 Mem0 的原子事实提取模式
5. **ARIS**（图结构社交世界模型）——23 人用户研究验证了显式关系图能提升好感度

---

## 八、参考链接

- Ha & Schmidhuber, "World Models" (2018): https://worldmodels.github.io
- LeCun, "A Path Towards Autonomous Machine Intelligence" (2022): https://openreview.net/pdf?id=BZ5a1r-kVsf
- DreamerV3: https://github.com/danijar/dreamerv3
- MuZero: https://www.nature.com/articles/s41586-020-03051-4
- Genie: https://deepmind.google/discover/blog/genie-2-a-large-scale-foundation-world-model/
- Sora: https://openai.com/sora
- MATE: https://zenodo.org/records/20400530
- CTEM / Auri: https://export.arxiv.org/abs/2605.15812
- Interaction World Models: https://www.media.mit.edu/projects/interaction-world-models/overview/
- ARIS: https://ar5iv.labs.arxiv.org/html/2605.00943
- Mem0: https://github.com/mem0ai/mem0
- Letta: https://github.com/letta-ai/letta
- digital-companion-core: https://github.com/Ahmed-KHI/digital-companion-core
- Graphiti (Zep): https://github.com/getzep/graphiti
