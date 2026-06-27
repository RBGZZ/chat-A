# 附录 A：世界模型（World Model）深度调研

> 子代理调研报告（2026-06-28），主文档见 [embodiment-architecture-2026-06-28.md](embodiment-architecture-2026-06-28.md)。聚焦"讲透原理 + 落地开源方案"，为 chat-A "语音陪伴 → 具身智能" 路线定制。

> 一句话结论：**世界模型现已从"论文 demo"跨入"有可跑开源权重"阶段，但真正"能在 6GB/嵌入式上端到端跑物理世界模型并零样本控制真机"的方案仍不存在；对 chat-A 当前阶段，真正该投入的是"社会世界模型"（建模用户心理/关系），物理世界模型只需在接缝上预留、选 1–2 个轻量开源项目（DreamerV3 / TD-MPC2 / V-JEPA 2 编码器）做技术储备。**

---

## 1. 把世界模型讲透

### 1.1 它是什么、解决什么问题

世界模型（World Model）是一个**可预测的、内部的环境动力学模型**：给定当前状态（或其压缩表示）和一个候选动作，它预测"接下来会发生什么"——下一帧的观测、下一时刻的隐状态、奖励等。核心价值是让 agent **在"脑内"想象（imagine / rollout）未来，从而规划，而不必每次都真的去环境里试错**。这正是它区别于普通强化学习的地方：用想象出来的轨迹训练策略 / 做规划，极大提升样本效率。([DreamerV3 论文](https://arxiv.org/abs/2301.04104))

它解决三个真实痛点：
- **样本效率**：真机/真环境交互昂贵且危险，世界模型把大部分试错搬进想象空间（IRIS 仅用 2 小时 Atari 游戏量就超过人类的 10/26 个游戏；[IRIS](https://arxiv.org/abs/2209.00588)）。
- **规划**：有了可微/可查询的动力学，就能做 MPC（模型预测控制）——在 latent 空间里展开多条未来、挑最优动作序列。
- **泛化/迁移**：好的世界模型学到的是"环境怎么运作"的通用规律，理论上可跨任务复用。

### 1.2 关键边界：世界模型 ≠ 感知 ≠ VLM ≠ 策略（很多人在这里混淆）

| 组件 | 回答的问题 | 输入→输出 | chat-A 类比 |
|---|---|---|---|
| **感知 / VLM** | "现在是什么？" | 观测 → 语义标签/描述 | "用户说了什么/语气如何"（ASR + prosody + 情感识别） |
| **世界模型** | "如果我做动作 a，接下来会怎样？" | (状态, 动作) → 未来状态/观测/奖励 | "如果我现在打断他/反对他，关系和情绪会怎么走" |
| **策略 / 控制器** | "我现在该做什么？" | 状态 → 动作 | 回合调度、要不要主动说话 |

最关键的区分：**感知是"读懂当下"，世界模型是"预测假设动作下的未来"。** VLM（如 GPT-4V、Cosmos-Reason）能描述一张图、做空间常识推理，但它本身**不是 action-conditioned 的前向动力学**——它不回答"我施加这个力之后物体会怎么动"。NVIDIA 自己也把这两者拆成两个产品：Cosmos-Predict（生成式世界模型，预测未来视频）vs Cosmos-Reason（理解/推理 VLM）。([Cosmos GitHub 组织](https://github.com/nvidia-cosmos))

### 1.3 三大技术流派

#### a) MBRL / 隐空间动力学派（Latent Dynamics + 想象 rollout + MPC）

**本质**：把高维观测压进一个低维 latent space，在 latent 里学一个递归动力学模型（"给定 z_t 和 a_t，预测 z_{t+1}、奖励、是否结束"），然后**完全在 latent 想象空间里**训练 actor-critic 或做 MPC 规划。

- **PlaNet → Dreamer → DreamerV3**（Danijar Hafner）：DreamerV3 用 **固定一套超参** 就横扫 150+ 任务（含 Minecraft 从零挖钻石），世界模型把观测编码成**离散分类表示**预测未来。2025 年登上 Nature。([论文](https://arxiv.org/abs/2301.04104)，[Nature/PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12003158/))
- **TD-MPC2**（Nicklas Hansen）：学一个**面向奖励的隐式动力学**（不重建像素），用 MPPI 在 latent 做 MPC 规划 + TD 学习，单模型多任务可扩展到 80 个连续控制任务。([tdmpc2.com](https://www.tdmpc2.com/))
- **IRIS**：用离散自编码器 + 自回归 Transformer 当世界模型，把"想象"做成"生成 token 序列"，样本效率极高。([论文](https://arxiv.org/abs/2209.00588))

**优**：样本效率冠绝、模型小（1–50M 参数即可）、可直接做规划、已在真机验证（[DayDreamer](https://arxiv.org/abs/2206.14176)：四足机器人 1 小时从零学会走路、真机在线学习无需仿真）。
**劣**：通常**逐任务/逐环境训练**，不是预训练大模型；视觉复杂场景重建昂贵；**零样本 Sim2Real 脆弱**——见下。

#### b) JEPA / 自监督表征预测派（LeCun 路线）

**本质**：LeCun 的核心主张是"**别在像素空间预测，在表征空间预测**"。JEPA（Joint-Embedding Predictive Architecture）不重建未来的每个像素，而是预测未来观测的**抽象嵌入**，从而绕开"生成无关细节"的浪费，逼模型学"重要的、可预测的"结构。I-JEPA（图像）→ V-JEPA（视频）→ **V-JEPA 2**（2025 重点）。

- **V-JEPA 2**（Meta, 2025-06）：先用 **100 万+ 小时视频**做无动作自监督预训练得到一个视频编码器；然后**冻结编码器**，在其上训一个 **action-conditioned 预测器 V-JEPA 2-AC**，仅用 **不到 62 小时**的无标注机器人视频（DROID 数据集）。部署时用 latent 空间的 MPC + 图像目标做规划，**零样本**在两个不同实验室的 Franka 机械臂上完成抓取/放置，成功率 65–80%，全程不采集这些机器人的数据、无任务奖励。([Meta 博客](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/)，[论文 arXiv:2506.09985](https://arxiv.org/abs/2506.09985))

**优**：这是目前最接近"**通用、预训练、action-conditioned、可零样本控制真机**"的开源世界模型；表征预测路线在效率和泛化上有理论优势。
**劣**：抓取/精细操作成功率仍中等；planning 用 MPC 较慢；编码器（ViT-g 1B / ViT-G 2B）不轻。

#### c) 生成式 / 视频世界模型派（Genie、Cosmos、Sora 类）

**本质**：直接在**像素/视频空间**生成"接下来会发生什么"，通常是 diffusion 或自回归 Transformer。给定提示/历史帧（+动作），生成逼真的未来视频，把视频生成器当作可交互的"神经游戏引擎/模拟器"。

- **Genie 系列**（DeepMind）：**Genie 3**（2025-08）能从文本生成 **720p / 24fps、可实时交互、保持几分钟一致性**的世界；最大卖点是**无监督从视频里推断潜在动作**（不需要动作标注）。但 **Genie 3 完全闭源**，2026-01-29 仅以 "Project Genie" 形式对美国 Google AI Ultra 订阅者开放。([DeepMind 博客](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/)，[Wikipedia](https://en.wikipedia.org/wiki/Genie_(world_model)))
- **NVIDIA Cosmos（World Foundation Models）**（CES 2025）：面向 Physical AI 的**预训练世界模型平台**，20M 小时数据训练，分 Nano/Super/Ultra 三档；代码 Apache 2.0、权重走 NVIDIA Open Model License（**允许商用，但限制用它训练竞品基础模型**）。([NVIDIA 博客](https://blogs.nvidia.com/blog/cosmos-world-foundation-models/)，[论文 arXiv:2501.03575](https://arxiv.org/abs/2501.03575))

**"能生成逼真视频 ≠ 理解物理"的争议（务必讲清）**：
LeCun 直言："**从提示生成看起来逼真的视频，并不表示系统理解了物理世界。生成（generation）与世界模型的因果预测（causal prediction）是两码事**"——因为合理视频的空间极大，生成器只要采样出"一个看起来对"的就算成功，并不需要因果。([VIVE 博客整理](https://blog.vive.com/us/soras-spark-in-the-world-models-debate-can-ai-truly-understand-physics/)) 实证研究（[PhyWorld](https://phyworld.github.io/)、WorldModelBench/WorldScore、2026 的 World-in-World/RBench 闭环评测）持续显示：**视觉逼真度 ≠ 可控性 / 物理一致性 / 因果泛化**，"感知-功能鸿沟"是 2026 年的核心议题。([世界模型综述](https://arxiv.org/html/2411.14499v4))

### 1.4 关键概念速记

- **latent space（隐空间）**：把高维观测压缩成的低维向量，世界模型在这里"思考"成本最低。
- **rollout / imagination（想象 rollout）**：用动力学模型从当前状态出发，反复 `z_{t+1}=f(z_t,a_t)` 展开一条假想轨迹，不碰真实环境。
- **MPC / 想象规划**：在 latent 里采样多条动作序列、用世界模型预测各自结果、挑评分最高的第一步执行，下一拍重规划（Dreamer 用想象训策略，TD-MPC2 / V-JEPA 2-AC 用 MPC）。
- **action-conditioned（动作条件化）**：预测显式以"将要执行的动作"为输入——这是世界模型区别于普通视频生成的命门。V-JEPA 2-AC、Cosmos-Predict-Action 才是真·世界模型形态。
- **domain randomization（域随机化）**：训练时随机化纹理/光照/物理参数，逼策略对真实世界的偏差鲁棒，是 Sim2Real 的传统主力。([Lil'Log](https://lilianweng.github.io/posts/2019-05-05-domain-randomization/))
- **为什么"零样本 Sim2Real"对 Dreamer 类脆弱**：Dreamer 的 latent 动力学是**从特定环境数据拟合**出来的，仿真与真实之间的"reality gap"（接触力、摩擦、传感噪声、视觉差异）会让想象出来的未来系统性偏离真实，规划随之失真；不做域随机化时尤其容易在真机崩。所以社区主流做法是 DayDreamer 那样**直接在真机在线学习**，或用生成式先验（V-Dreamer）合成多样场景来补。([Sim2Real 综述](https://www.emergentmind.com/topics/sim2real-transfer-method)，[V-Dreamer](https://arxiv.org/pdf/2603.18811))

---

## 2. 开源方案地图

> 说明：VRAM 数字分"模型本身能跑"和"复现训练"两种语境，已尽量标注；星标为 2026-06 抓取的近似值。

| 项目 | 流派 | 仓库 / 链接 | Star | License | 参数量 | 显存/硬件 | 预训练权重 | 边缘/6GB 可行性 | 成熟度 |
|---|---|---|---|---|---|---|---|---|---|
| **DreamerV3** | 隐空间 MBRL | [danijar/dreamerv3](https://github.com/danijar/dreamerv3) | ~3.5k | MIT | 配置可调，含 `size50m`（~12M–200M 档） | 单卡可训，OOM 时 `--batch_size 1`；JAX | ❌ 从零训练 | ✅ **小模型最现实**：世界模型本体很小，6GB 可训低维/小图任务 | 生产级算法，社区广泛复现 |
| **TD-MPC2** | 隐空间 MBRL+MPC | [nicklashansen/tdmpc2](https://github.com/nicklashansen/tdmpc2) | ~874 | MIT | {1,5,19,48,317}M | 单任务 8GB GPU 推荐 / 317M 需 24GB；多任务离线需 128GB RAM | ✅ **300+ checkpoint**（含 12 个多任务） | ✅ **5M 默认模型极轻**，推理/规划 6GB 可行 | 论文+成熟代码+权重齐全 |
| **IRIS** | Transformer 世界模型 | [eloialonso/iris](https://github.com/eloialonso/iris) | ~891 | **GPL-3.0**（注意：传染性） | 中等（Atari 级） | 单 GPU；Atari100k | ✅ HF 上有 pretrained | ⚠️ 仅 Atari、研究向 | ICLR'23 研究代码 |
| **V-JEPA 2 / 2-AC** | JEPA 表征预测 | [facebookresearch/vjepa2](https://github.com/facebookresearch/vjepa2) | ~4.2k | MIT + Apache-2.0 | ViT-L 300M / ViT-H 600M / ViT-g 1B / (2.1) ViT-G 2B | 推理：ViT-L 可上消费级卡；AC+MPC 规划较重 | ✅ HF + torch.hub（含 2.1，2026-03 发布） | ⚠️ 编码器 300M 档**推理**勉强可上 6GB；真机零样本 demo 用更大算力 | **当前最强开源 action-conditioned 世界模型**，有真机 demo |
| **NVIDIA Cosmos Predict 2/2.5** | 生成式视频世界模型 | [nvidia-cosmos/cosmos-predict2](https://github.com/nvidia-cosmos/cosmos-predict2) | ~760 | 代码 Apache-2.0 / 权重 NVIDIA Open Model License（商用受限） | 2B / 14B | **2B Video2World 720p ≈ 32.5GB**；14B ≈ 49GB；官方推荐 H100/A100 80GB | ✅ HF 多个权重 | ❌ **数据中心级，6GB 完全跑不动** | 平台级、文档完善，但重 |
| **Cosmos-Reason** | 推理 VLM（非世界模型） | [Cosmos 组织](https://github.com/nvidia-cosmos) | — | NVIDIA Open Model License | ~7B 级 | 大 | ✅ | ❌ | 配套理解模型 |
| **Genie 3** | 生成式交互世界 | [DeepMind](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/) | — | **闭源/不可获取** | 未公开 | 数据中心 | ❌ 仅 Project Genie 订阅 | ❌ | SOTA 但封闭 |
| **TinyWorlds** | Genie 复刻（教育） | [AlmondGod/tinyworlds](https://github.com/AlmondGod/tinyworlds) | 小众（2026-06 新） | **MIT** | 极小（自回归离散 token） | 单卡/可玩具规模 | 训练脚本 | ✅ **学原理最佳**：无监督动作推断、可在小卡训 | 独立研究/教学，非生产 |
| **GenieRedux** | Genie 复刻（研究框架） | [insait-institute/GenieRedux](https://github.com/insait-institute/GenieRedux) | 小众 | 见仓库 | 中等 | 单/多卡 | 部分 | ⚠️ 研究向，带 RetroAct 数据集 | 学术框架 |
| **DayDreamer** | 真机 MBRL | [danijar 项目页](https://danijar.com/project/daydreamer/) / [arXiv](https://arxiv.org/abs/2206.14176) | （随 Dreamer 代码） | 同 Dreamer | 小 | 真机在线学习（学习线程+执行线程解耦） | — | ✅ 思路适配嵌入式（解耦低延迟） | 经典真机验证 |

**专为边缘/轻量的世界模型现状**：除了"把 DreamerV3/TD-MPC2 调到最小档"这条务实路线外，**目前没有一个成熟、有权重、专为 6GB/树莓派打造的通用物理世界模型**。Cosmos 的 "Nano 档" 和 Transfer2.5 的 "Distilled Edge" 模型主打"低延迟边缘部署"，但实测显存仍是几十 GB 级、"边缘"指的是车载/工业 GPU，**不是树莓派那种边缘**。([Cosmos Transfer2.5 Edge](https://github.com/nvidia-cosmos/cosmos-transfer2.5))

---

## 3. 诚实评估：炒作 vs 现实

**真能用的开源（有权重、能复现、license 友好）**：
- **TD-MPC2** —— 最"开箱即用"：MIT、300+ 现成 checkpoint、最小 5M 模型、连续控制可直接跑。控制类首选。
- **DreamerV3** —— 算法成熟、MIT、社区复现多；但要**自己从零训练**（无官方权重）。
- **V-JEPA 2 / 2-AC** —— Meta 官方权重 + 真机零样本 demo，**当前唯一"通用预训练 + action-conditioned + 真机"开源组合**，是这一波最有分量的开源世界模型。

**论文 demo / 期货 / 需谨慎**：
- **IRIS / GenieRedux / TinyWorlds** —— 研究/教学价值高，**不是生产件**；IRIS 还是 **GPL-3.0**（传染性 license，商用要小心）。
- **生成式视频世界模型整体** —— "逼真 ≠ 理解物理"的争议未解，作为真机控制器仍不可靠；当训练数据/仿真生成器用很好，当实时控制后端不行。

**License 雷区**：
- **IRIS = GPL-3.0**：嵌入闭源产品有传染风险。
- **Cosmos 权重 = NVIDIA Open Model License**：可商用，但**禁止用其输出/模型去训练竞争性基础模型**，且需读条款。
- **Genie 3 = 完全闭源**，不可自部署。
- DreamerV3 / TD-MPC2 / V-JEPA 2 / TinyWorlds = **MIT/Apache，最干净**。

**6GB 显存 + 嵌入式约束下，现实能跑哪一档？**
- ✅ **能跑**：DreamerV3 小档、TD-MPC2（1–5M）这类**隐空间 MBRL**——世界模型本体只有几 M 到几十 M 参数，**真正的瓶颈在视觉编码而非动力学**。低维状态/小分辨率图像的控制任务，6GB 可训可跑、可真机在线（DayDreamer 范式）。这是**树莓派/6GB 级别唯一现实的物理世界模型档位**。
- ⚠️ **勉强（仅推理/特征提取）**：V-JEPA 2 的 ViT-L 300M 编码器做**表征推理**可上 6–8GB，但完整 AC + MPC 规划闭环偏重、偏慢，真机零样本 demo 用的是更大算力。
- ❌ **跑不动**：Cosmos（2B 就要 32GB）、Genie 3（闭源数据中心）、任何生成式视频世界模型——**与 6GB/嵌入式完全不在一个量级**。

**一句话**：嵌入式世界模型的现实是"**小而专的隐空间动力学**"，不是"**大而通的视频生成**"。后者是云端/未来，前者是树莓派的当下。

---

## 4. 落到 chat-A

chat-A 内部已正确区分两类世界模型，这个划分非常关键，直接决定优先级：

### 4.1 社会世界模型（建模用户心理/关系）—— **现在就该投入，且不需要上面任何重型项目**

这才是"语音陪伴伴侣"阶段的真·世界模型需求。它的形态不是 ViT/diffusion，而是 **Theory-of-Mind（心智理论）+ 关系状态动力学**：建模"用户当前相信什么/想要什么/情绪如何"，并预测"如果小雪此刻打断/反对/共情，关系和情绪会怎么走"——这正好对应世界模型的 action-conditioned 本质，只是状态空间是**社会/心理**而非物理。

- 2025–2026 这条线很活跃且**与 LLM 同构**，可直接落到 chat-A 现有 LLM 认知层：
  - **Social World Models**（[arXiv:2509.00559](https://arxiv.org/pdf/2509.00559)）：把世界模型扩展为"包含他者信念/意图/潜在动作"的表示。
  - **ToMAgent / 把 ToM 注入社交 LLM agent**（[arXiv:2509.22887](https://arxiv.org/abs/2509.22887)）：用"ToM + 对话前瞻"训练，产生对达成对话目标最有用的"对方心智状态"，实现长程适应、维护关系——**和 chat-A "会主动、会反对、长期伴侣"的北极星高度吻合**。
  - **用户-agent 认知分歧/ToM 评测**（[arXiv:2602.13832](https://arxiv.org/html/2602.13832v1)）：构建用户信念表征、识别用户信念与现实的关键 gap 并主动管理——可直接指导 chat-A 的人格/记忆-召回策略。
- **落地建议**：把"社会世界模型"实现为 chat-A 记忆/人格层之上的一个**轻量预测模块**：维护"用户情绪/关系/意图"的隐状态（可复用现有 PAD 情绪 + 记忆），用 LLM 做 action-conditioned 前瞻（"如果这样回应，用户会…"）。**零新硬件、零显存压力，纯软件，且正中陪伴产品的命门。** 这与项目已有的"prosody→PAD""主动消息""可追溯"完全可拼装。

### 4.2 物理世界模型（建模环境动力学）—— **远期，现在只做接缝预留 + 1–2 个轻量储备**

只有当 chat-A 真正迈向 VTuber→VRChat→真实机器人时才需要物理世界模型。现阶段动作：

- **现在该关注/可小试**：
  - **DreamerV3 / TD-MPC2**：作为"嵌入式可跑的隐空间 MBRL"标杆，符合项目的 6GB/树莓派硬约束。建议把它们当作**未来 embodied 控制层的接缝**预留（类比项目 day-1 就埋的 TTS/STT Factory 接缝），并用 TD-MPC2 现成权重做一次小 demo 验证团队对"latent 动力学 + MPC 规划"的理解。
  - **V-JEPA 2（编码器）**：作为"通用视觉表征 + action-conditioned 预测"的最先进开源参考，先**跟踪、读权重、跑编码器特征**，理解 JEPA 路线（这也是 LeCun 押注、最可能成为长期赢家的方向）。
- **现在不该碰**：Cosmos / Genie 3 —— 数据中心级、与嵌入式约束矛盾；**唯一现实用途是未来当"合成训练数据/仿真器"在云端用**，而非端上世界模型。
- **真机阶段的范式参考**：**DayDreamer** 的"真机在线学习 + 学习/执行线程解耦以满足延迟"思路，与 chat-A 已确立的"延迟预算/非阻塞/优雅降级"开发原则天然契合，是未来 embodied 落地最该借鉴的工程范式。

### 4.3 给主理人的认知校正（针对"理解还不够深"）

1. **世界模型不是感知**。chat-A 现有的 ASR/prosody/情感识别是"感知"；世界模型是"给定我的动作，预测未来"。别把上一个更强的 VLM 当成"有了世界模型"。
2. **嵌入式的物理世界模型 = 小隐空间动力学，不是视频生成**。盯 Dreamer/TD-MPC2，别被 Cosmos/Genie/Sora 的炫酷 demo 带偏预算和硬件预期。
3. **陪伴产品的"世界模型"红利在社会维度**。在迈向具身之前，"社会世界模型 / ToM"是性价比最高、最贴北极星、且**纯软件零硬件门槛**的世界模型投入——应当作为近期重点，物理世界模型保持接缝预留 + 技术跟踪即可。

---

## 来源（可点击）

- V-JEPA 2：[Meta 博客](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) · [论文 arXiv:2506.09985](https://arxiv.org/abs/2506.09985) · [仓库 facebookresearch/vjepa2](https://github.com/facebookresearch/vjepa2) · [HF 权重集合](https://huggingface.co/collections/facebook/v-jepa-2-6841bad8413014e185b497a6) · [LearnOpenCV 指南](https://learnopencv.com/v-jepa-2-meta-world-model-robotics-guide/)
- NVIDIA Cosmos：[NVIDIA 博客](https://blogs.nvidia.com/blog/cosmos-world-foundation-models/) · [论文 arXiv:2501.03575](https://arxiv.org/abs/2501.03575) · [cosmos-predict2 仓库](https://github.com/nvidia-cosmos/cosmos-predict2) · [cosmos-predict2.5 仓库](https://github.com/nvidia-cosmos/cosmos-predict2.5) · [模型矩阵/显存](https://docs.nvidia.com/cosmos/latest/predict2/model_matrix.html) · [Cosmos 组织](https://github.com/nvidia-cosmos)
- DreamerV3：[仓库 danijar/dreamerv3](https://github.com/danijar/dreamerv3) · [论文 arXiv:2301.04104](https://arxiv.org/abs/2301.04104) · [Nature/PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC12003158/) · [项目页](https://danijar.com/project/dreamerv3/)
- TD-MPC2：[仓库 nicklashansen/tdmpc2](https://github.com/nicklashansen/tdmpc2) · [tdmpc2.com](https://www.tdmpc2.com/) · [论文 PDF](https://arxiv.org/pdf/2310.16828)
- IRIS：[仓库 eloialonso/iris](https://github.com/eloialonso/iris) · [论文 arXiv:2209.00588](https://arxiv.org/abs/2209.00588)
- Genie 3：[DeepMind 博客](https://deepmind.google/blog/genie-3-a-new-frontier-for-world-models/) · [Wikipedia](https://en.wikipedia.org/wiki/Genie_(world_model)) · [The Register（Project Genie 发布）](https://www.theregister.com/2026/01/29/googles_project_genie_ai)
- TinyWorlds / GenieRedux：[AlmondGod/tinyworlds](https://github.com/AlmondGod/tinyworlds) · [BrightCoding 解析](https://www.blog.brightcoding.dev/2026/06/18/tinyworlds-the-secret-genie-clone-scaling-world-models-without-actions) · [insait-institute/GenieRedux](https://github.com/insait-institute/GenieRedux)
- DayDreamer（真机 MBRL）：[项目页](https://danijar.com/project/daydreamer/) · [论文 arXiv:2206.14176](https://arxiv.org/abs/2206.14176)
- "生成 ≠ 理解物理" 争议：[VIVE 博客（LeCun 观点）](https://blog.vive.com/us/soras-spark-in-the-world-models-debate-can-ai-truly-understand-physics/) · [PhyWorld](https://phyworld.github.io/) · [世界模型综述 arXiv:2411.14499](https://arxiv.org/html/2411.14499v4)
- Sim2Real / 域随机化：[Sim2Real 综述](https://www.emergentmind.com/topics/sim2real-transfer-method) · [Lil'Log 域随机化](https://lilianweng.github.io/posts/2019-05-05-domain-randomization/) · [V-Dreamer](https://arxiv.org/pdf/2603.18811)
- 社会世界模型 / ToM：[Social World Models arXiv:2509.00559](https://arxiv.org/pdf/2509.00559) · [ToMAgent arXiv:2509.22887](https://arxiv.org/abs/2509.22887) · [用户-agent ToM 评测 arXiv:2602.13832](https://arxiv.org/html/2602.13832v1)
- 综合资源：[Awesome-World-Models（knightnemo）](https://github.com/knightnemo/Awesome-World-Models) · [Awesome-World-Models（JiahuaDong）](https://github.com/JiahuaDong/Awesome-World-Models)
