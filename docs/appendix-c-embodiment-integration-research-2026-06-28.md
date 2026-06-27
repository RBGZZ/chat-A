# 附录 C：Agent × 世界模型 × VLA 集成与具身栈调研

> 子代理调研报告（2026-06-28），主文档见 [embodiment-architecture-2026-06-28.md](embodiment-architecture-2026-06-28.md)。聚焦"三者融合 / 端到端编排栈 / 云脑-本地小脑 / 诚实成熟度 / chat-A 落地接缝"。

## 0. 一句话结论

2025-2026 的前沿共识已经从"世界模型 vs VLA 二选一"彻底转向**融合**：世界模型不再是独立的规划器，而是以四种角色嵌进 VLA 的训练/推理闭环——**数据引擎、后训练 RL 环境、隐空间预测的辅助监督、想象 rollout**。其中**有真代码+权重**的只有一小撮（GigaBrain-0、WorldVLA、V-JEPA 2、GR00T、Cosmos、UWM、Voyager），多数 2026 年的"闭环/双流"方案仍是**论文期货（code/weights in preparation）**。端到端"具身 Agent 编排栈"真正可用的不是学术框架而是**工程胶水**（AWS Strands + NVIDIA GR00T + HF LeRobot 这条线）。"云脑下发隐空间目标"这个 symbol→latent 接地问题，**现实里没人真这么干**——大家都退化成"云端发自然语言子目标，本地 VLA 当条件吃"。6GB 边缘约束下，上述重型 VLA **一个都塞不进**，必须走蒸馏小模型路线。

---

## 1. 世界模型 × VLA 的融合（前沿重点）

### 1.1 融合的四种"怎么融"范式

| 融合角色 | 机制 | 代表工作 |
|---|---|---|
| **A. 数据引擎**（World Model as Data Engine） | 世界模型生成海量合成轨迹/视频，减少真机数据依赖 | GigaWorld-0 → GigaBrain-0；Cosmos Transfer/Predict |
| **B. 后训练 RL 环境**（World Model as Virtual Env） | 真实世界不可重置，用世界模型当可回滚仿真器跑 RL post-training + 给 reward | World-Env、World-VLA-Loop、WoVR、GigaBrain-0.5M* |
| **C. 隐空间预测辅助监督**（Implicit World Modeling） | 让策略网络对齐"未来观测的 latent"，学会预判长期后果，几乎不改架构 | FLARE、V-JEPA 2-AC |
| **D. 统一自回归/扩散**（单模型既预测未来又出动作） | 动作和未来图像在同一序列/同一 diffusion 里联合建模，互相增强 | WorldVLA、UWM、Dual-Stream Diffusion(DUST) |

### 1.2 逐项核查（有无开源 / 真代码权重）

| 项目 | 融合范式 | 开源状态 | 链接 |
|---|---|---|---|
| **GigaBrain-0** | A+B（世界模型数据+RL） | ✅ **权重已发**（2025-11-27），含架构/预训练/后训练实现。~1k 小时真机+大量世界模型生成数据。GigaBrain-0.1 登顶 RoboChallenge；GigaBrain-0.5M*(2026-02)加世界模型 RL | [github](https://github.com/open-gigaai/giga-brain-0) · [站点](https://gigabrain0.github.io/) · [paper 2510.19430](https://huggingface.co/papers/2510.19430) |
| **GigaWorld-0** | A（数据引擎本体） | ✅ 开源，"World Models as Data Engine" | [github](https://github.com/open-gigaai/giga-world-0) |
| **WorldVLA** (阿里达摩，现 RynnVLA-002) | D（统一自回归） | ✅ **code+权重**（2025-06-23），基于 Chameleon，三 tokenizer（VQ-GAN图像/BPE文本/256-bin动作），LIBERO 基准 | [github](https://github.com/alibaba-damo-academy/WorldVLA) · [paper 2506.21539](https://huggingface.co/papers/2506.21539) |
| **V-JEPA 2 / V-JEPA 2-AC** (Meta, 2025-06-11) | C（隐空间预测）+ action-conditioned 世界模型 | ✅ **开源+权重**（HF/transformers）。AC 变体仅用 62h DROID 机器人视频微调，300M block-causal transformer，预测"动作条件下的未来 video embedding"，规划 ~16s/步（Cosmos 要 4min）。无奖励监督即可在陌生机械臂上 pick-and-place | [Meta blog](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) · [HF docs](https://huggingface.co/docs/transformers/model_doc/vjepa2) · [paper 2506.09985](https://arxiv.org/abs/2506.09985) |
| **World-Env** | B（虚拟环境后训练） | ⚠️ 有 repo（amap-cvlab/world-env），视频世界仿真器+VLM 即时反射器给 reward，5 条示范/任务即可 | [paper 2509.24948](https://arxiv.org/abs/2509.24948) · [github](https://github.com/amap-cvlab/world-env) |
| **World-VLA-Loop** (showlab, 2026-02-09) | B（闭环互相精炼） | ❌ **code/weights in preparation**。状态感知视频世界模型当高保真仿真器，VLA 失败轨迹回灌精炼世界模型，2 轮联合优化真机成功率 **+36.7%**；SANS 近成功轨迹数据集 | [paper 2602.06508](https://arxiv.org/abs/2602.06508) · [github](https://github.com/showlab/World-VLA-Loop) |
| **FLARE** (NVIDIA) | C（implicit world modeling） | ⚠️ 论文为主。对齐 DiT 特征与未来观测 latent，仅加几个 token 到标准 VLA；RoboCasa 24 任务 70.1% vs UWM 60.8% | [paper 2505.15659](https://arxiv.org/abs/2505.15659) |
| **UWM** (WeirdLab UW) | D（视频+动作扩散联合预训练） | ✅ 有 code。多模态 diffusion transformer，动作与视频用独立 diffusion timestep，可同时学策略/正逆动力学/视频预测；把无标注视频当"动作=噪声"纳入训练 | [站点](https://weirdlabuw.github.io/uwm/) |
| **Dual-Stream Diffusion (DUST)** | D（双流扩散增强 VLA） | ⚠️ 有 code 页面（2510.27607）。多模态 DiT 保持独立模态流+跨模态共享，解耦 flow-matching loss；RoboCasa/GR-1 比 SOTA 高 ~6% | [paper 2510.27607](https://arxiv.org/abs/2510.27607) |
| **RoboDreamer** (ICML 2024) | A/D（组合式想象世界模型） | ✅ 有 code，较早期 | [Awesome-World-Models 索引](https://github.com/leofan90/Awesome-World-Models) |
| **NVIDIA Cosmos + GR00T** | A+B（WFM 数据/仿真）+人形 VLA | ✅ 见 §下表 | — |

### 1.3 NVIDIA Cosmos + GR00T 这对组合具体怎么配

- **Cosmos = 世界基础模型（WFM）**：生成式世界模型平台，含 Cosmos-Predict（预测未来）、Cosmos-Transfer（给仿真加真实光照/材质做 sim2real）、Cosmos-Reason（推理 VLM）、新增 **Cosmos-Policy**。2026-06 发布 Cosmos 3「全模态世界模型」。
- **GR00T = 人形 VLA**：N1.7 用 **Cosmos-Reason2-2B / Qwen3-VL** 当 VLM backbone（System 2），DiT 当 System 1 出动作；预测**紧凑 latent action token**由学到的全身控制器解码成全身关节命令。
- **怎么配**：Cosmos Transfer 给 Isaac GR00T Blueprint 生成合成操作轨迹（数据引擎），GR00T 在 Isaac Lab 里训练，Cosmos 当仿真后端。这就是范式 A+B 的工业级实现。
- 来源：[Cosmos 官页](https://www.nvidia.com/en-us/ai/cosmos/) · [Pretrained to Imagine, Fine-Tuned to Act（世界-动作模型综述）](https://developer.nvidia.com/blog/pretrained-to-imagine-fine-tuned-to-act-the-rise-of-world-action-models/) · [Cosmos Policy / Robot Report](https://www.therobotreport.com/nvidia-adds-cosmos-policy-world-foundation-models/)

---

## 2. 端到端具身 Agent 开源栈 / 编排框架

**关键发现**：把"LLM 规划+感知+世界模型+动作"真正串起来的，**不是学术框架，而是工程编排栈**。学术界给的是单点模型（VLA、世界模型），编排靠工业胶水。

| 栈/框架 | 角色 | 成熟度 | License | 硬件 | 链接 |
|---|---|---|---|---|---|
| **NVIDIA Isaac GR00T** | 人形 VLA 基础模型+数据管线 | 高（N1.7，工业级） | **Apache 2.0** | 推理 16GB+ VRAM GPU；base 模型 ~6GB；支持 Jetson Thor/Orin | [github](https://github.com/NVIDIA/Isaac-GR00T) |
| **NVIDIA Isaac Lab** | 机器人学习/仿真训练框架（GR00T 平台地基） | 高 | **BSD-3** | NVIDIA GPU + Omniverse | [docs](https://isaac-sim.github.io/IsaacLab/) |
| **HF LeRobot** | 硬件抽象+数据接口+小型 VLA（SmolVLA/Pi0） | 高，活跃 | **Apache 2.0** | CPU/小 GPU 可跑小模型 | huggingface/lerobot |
| **AWS Strands Agents** | 跨边缘-云的 agent 编排 SDK（agent-as-tools） | 1.0（2025-07），新但工程可用 | 开源（Apache 2.0） | 云+边缘 | [AWS 物理 AI blog](https://aws.amazon.com/blogs/opensource/building-intelligent-physical-ai-from-edge-to-cloud-with-strands-agents-bedrock-agentcore-claude-4-5-nvidia-gr00t-and-hugging-face-lerobot/) |
| **OpenMind OM1** | 模块化、硬件无关 AI 运行时 + FABRIC 协调协议 | 新兴 | 开源 | 多平台 | 见综述 |
| **Voyager** (MineDojo) | **LLM 技能库范式**鼻祖：自动课程+可执行代码技能库+自验证迭代 | 成熟（2023，被广泛 fork） | MIT 系 | 仅需 LLM API（GPT-4 黑盒，无需微调） | [github](https://github.com/MineDojo/Voyager) |

**Voyager 范式对 chat-A 的价值**：它证明了"LLM + 不断增长的可执行技能库 + 环境反馈自修正"可以在不微调模型的前提下做开放式具身学习。这正是 chat-A "Agent 大脑"层最现实的起点——技能库=可调用的能力/工具，与项目已有的"模型侧 Anthropic tool-use / 能力侧 MCP"分层决策天然对齐。

综述参考：[Towards Embodied Agentic AI (2508.05294)](https://arxiv.org/html/2508.05294v1)。

---

## 3. "云端大脑 + 本地小脑"级联架构的现实性

### 3.1 真有人做，但接口不是你想的那样

**唯一成体系的开源参考架构 = AWS 那篇 edge-to-cloud 物理 AI blog**，明确按 System 2/System 1 切：

- **云端（System 2，慢/审慎）**：Claude Sonnet 4.5 做多步规划、AgentCore Memory 存跨设备/跨天的 fleet 上下文、SageMaker 跑仿真训练。
- **边缘（System 1，快/本能）**：GR00T VLA 在 Jetson 上做毫秒级感觉-运动控制；Strands + 轻量模型（Qwen3-VL via Ollama）。
- **委派模式**：边缘遇到"需要更深推理"的情况才上呼云端。
- 来源：[AWS blog](https://aws.amazon.com/blogs/opensource/building-intelligent-physical-ai-from-edge-to-cloud-with-strands-agents-bedrock-agentcore-claude-4-5-nvidia-gr00t-and-hugging-face-lerobot/)

### 3.2 核心质疑：symbol → latent grounding 现实里怎么解？

**结论：现实里没人真把"云端 LLM 的符号目标"直接注入"本地世界模型的隐空间"。** 接地问题被三种务实手段绕过：

1. **退化成自然语言子目标（主流，AWS/GR00T 这条线）**：云端 LLM 输出**语言指令**（"prepare breakfast" → "pick up the strawberry"），本地 VLA 把语言当**条件 token**吃进去出关节角。grounding 发生在 VLA 自己的视觉-语言对齐里，符号边界=自然语言，**不是 latent**。简单、可调试、可追溯——代价是带宽低、语义粒度粗。
2. **latent action codebook + 逆动力学模型（GR00T 内部机制）**：GR00T 用 VQ-VAE 学一个 **latent-action codebook**，再用训练好的 **逆动力学模型(IDM)** 从无动作视频/人类视频里反推伪动作。注意——**这是模型内部从视频学动作的机制，不是云-边接口**。它解决的是"如何利用无标注视频"，不是"如何让云脑下发隐空间目标"。
3. **显式语言-动作对齐做分层 grounding（学术新方向）**：如 [Grounding Hierarchical VLA Through Explicit Language-Action Alignment (2604.05614)](https://arxiv.org/html/2604.05614v1) 和 [RoboSemanticBench (2606.02277)](https://arxiv.org/html/2606.02277)，正在研究怎么诊断/强化高层语言子目标到低层动作的语义接地——**仍以语言为符号边界**。

**对 chat-A 的硬启示**：别在架构里押注"云脑直接写本地 latent"这种期货接口。**符号边界用自然语言/结构化意图**（与项目已有 tool-use/MCP 一致），世界模型隐空间是 VLA 模块的**内部实现细节**，藏在 ActionPort 后面。

---

## 4. 诚实评估：炒作 vs 现实

### 4.1 真代码+权重 / 论文期货 分类

| 成熟度 | 项目 |
|---|---|
| ✅ **真权重可跑** | GigaBrain-0、WorldVLA、V-JEPA 2(+AC)、GR00T N1.5/N1.7、Cosmos(Predict/Transfer/Reason)、UWM、RoboDreamer、Voyager、Isaac Lab、LeRobot |
| ⚠️ **有 repo 但权重/复现不全** | World-Env、DUST、FLARE |
| ❌ **论文期货（code in prep）** | World-VLA-Loop、WoVR、多数 2026 "闭环/prophesying" 类 |

### 4.2 端到端开源具身栈的真实成熟度

- **没有一个"一键端到端开源具身 Agent 栈"**。能用的是**拼装**：LeRobot(硬件/数据) + GR00T(VLA) + Isaac Lab(训练/仿真) + 自己写编排(Strands 或自研)。
- 世界模型与 VLA 的"融合"在**论文 benchmark（LIBERO/RoboCasa）上+6%~+36%**，真机泛化仍主要靠数据规模（GigaBrain 1k→10k 小时），融合是锦上添花不是银弹。
- **闭环联合训练（World-VLA-Loop 式）是 2026 最热方向，但全是 in-preparation**，现在无法依赖。

### 4.3 6GB / 边缘约束下的现实

**残酷事实：重型 VLA 在 6GB 上一个都跑不动。**

| 模型 | 边缘实测 | 6GB 可行性 |
|---|---|---|
| GR00T N1 | Jetson Orin ~2Hz，需 action chunking（预测 10-20 步、50Hz 执行），200-500ms/次；推理要 16GB+ VRAM | ❌ 远超 6GB |
| Pi0 / Pi0.5 | Jetson **Thor** 44-46ms（22-23Hz） | ❌ 依赖 Thor 高端 |
| **SmolVLA / NanoVLA / Shallow-π（蒸馏）** | 为边缘设计，参数量小 | ⚠️ 唯一现实方向 |

- 来源：[Edge AI on Jetson 指南](https://developer.nvidia.com/blog/getting-started-with-edge-ai-on-nvidia-jetson-llms-vlms-and-foundation-models-for-robotics/) · [VLA 模型对比 2026](https://www.roboticscenter.ai/tools/vla-models-comparison) · [Jetson Thor 实测帖](https://forums.developer.nvidia.com/t/real-time-inference-on-thor-rtx-pi0-5-gr00t-n1-6-1-7-thor-23-hz-rtx-5090-50-80hz/368788)
- **对 chat-A 6GB 树莓派级**：本地只可能跑**蒸馏小 VLA / 轻量策略**，重型世界模型推理（想象 rollout）和 LLM 规划必须**在云端或开发期仿真里**，本地小脑只做反应式执行。这与项目既有的"PC 优先验证、TTS 才是真瓶颈、五类后端 Factory 接缝"判断完全一致。

---

## 5. 落到 chat-A：分阶段集成建议

chat-A 的四角色（感知→Agent 大脑→世界模型→VLA 小脑）与 2025-2026 前沿**结构同构**——这是好消息，迁移代价可控。关键是**现在埋接缝、别现在押注期货模型**。

### 5.1 现在就埋的接缝（设计阶段，零成本）

| 接缝 | 定义 | 对齐的开源范式 | 理由 |
|---|---|---|---|
| **ActionPort** | 抽象动作出口：输入=结构化意图/语言子目标，输出=动作指令（VTuber 期=表情/姿态/VRChat OSC；真机期=关节命令） | LeRobot 的硬件抽象、GR00T 的 VLA 接口 | 符号边界用**自然语言/结构化意图**，不押注 latent 注入（见 §3.2） |
| **WorldModelPort** | 抽象"想象/预演/安全护栏"：输入=当前状态+候选动作，输出=预测未来观测+风险评分。**day1 可空实现/直通** | V-JEPA 2-AC(预测未来 latent)、World-Env(reward+termination)、FLARE(latent 对齐) | 让世界模型成为可插拔旁路，绝不焊进首字延迟（与项目"非阻塞召回"原则同构） |
| **PlannerPort** | Agent 大脑出口：LLM 规划+技能库 | **Voyager 范式**（技能库+自验证）、Strands | 与已有 tool-use/MCP 分层天然对齐 |
| **PerceptionPort** | 多模态感知入口 | GR00T 的 VLM backbone | 已有语音管线可作为感知子集 |

**硬约束（写进设计）**：WorldModelPort 必须**异步旁路+可降级**，护栏判定超时即放行/保守降级，绝不阻塞回合调度——直接复用项目"非阻塞召回"和"优雅降级"原则。

### 5.2 中期（VTuber / VRChat 阶段）验证什么

- **在纯软件域验证三角色编排闭环**：PlannerPort(LLM 规划) → WorldModelPort(预演候选动作的"社交后果"/安全护栏，比如"这句话会不会冒犯") → ActionPort(VRChat OSC 表情/动作)。这里**世界模型不必是物理世界模型**，可以是轻量的"社交/对话后果预测器"——但用同一个 Port，远期换成物理世界模型时编排不变。
- **用 World-Env / 想象 rollout 范式做"预演"而非真执行**：VTuber 阶段动作无物理风险，正好低成本验证"想象→护栏→执行"的数据流和延迟预算。
- **可追溯性**：复用已有 `CHAT_A_VOICE_TRACE` 范式，给 WorldModelPort/ActionPort 加结构化 trace，把"为什么选这个动作/护栏为什么拦"记下来（项目"行为可追溯"原则）。

### 5.3 远期（真机）接什么

- **本地小脑**：蒸馏小 VLA（SmolVLA/NanoVLA 级），或 GR00T N 系（若上 Jetson Thor/Orin 而非 6GB 树莓派）。
- **云脑-本地分工**：照 AWS Strands+GR00T 参考架构——云端 LLM 规划+世界模型重型想象，本地 VLA 反应式执行，**接口=自然语言/结构化子目标**。
- **数据引擎/后训练**：用 Cosmos/GigaWorld 范式生成合成数据，World-VLA-Loop 式闭环 RL 后训练（**届时这些应已开源成熟，现在别依赖**）。

### 5.4 现在就该架构对齐的开源栈（优先级）

1. **HF LeRobot**（Apache 2.0）——ActionPort/PerceptionPort 的硬件抽象对齐它，迁移最省力。
2. **Voyager 范式**——PlannerPort 的技能库设计直接借鉴。
3. **GR00T 接口形态**（Apache 2.0）——ActionPort 输出契约对齐其 VLA 输入（语言+图像→动作 token），未来可直接接。
4. **V-JEPA 2-AC**（开源权重）——WorldModelPort 的"动作条件未来预测"参考实现，是当前最现实的可跑世界模型。
5. **暂不依赖**：World-VLA-Loop、GigaBrain RL、闭环联合训练——全是期货，留接缝即可。

---

## 关键风险提示（给项目决策）

1. **别押注 latent 接地接口**：symbol→latent 下发是未解难题，现实退化成自然语言。chat-A 符号边界定在自然语言/结构化意图，安全。
2. **6GB 树莓派跑不了任何重型 VLA/世界模型**：本地只做反应执行，重计算上云或留在开发期仿真。这点必须写进部署假设。
3. **"融合"目前是 benchmark 收益（+6%~36%），不是质变**：真机泛化主要还靠数据规模。世界模型当"想象/护栏"的价值（安全、可解释）对陪伴 Agent **比刷点更重要**——这恰是 chat-A 该差异化用世界模型的地方（社交后果预演 > 物理 rollout）。
4. **2026 最热的闭环联合训练全是期货**：架构留 WorldModelPort 接缝，实现等开源成熟。

### 主要来源汇总
- [GigaBrain-0 github](https://github.com/open-gigaai/giga-brain-0) · [GigaWorld-0](https://github.com/open-gigaai/giga-world-0) · [GigaBrain-0.5M*](https://gigabrain05m.github.io/)
- [V-JEPA 2 Meta blog](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) · [paper](https://arxiv.org/abs/2506.09985)
- [WorldVLA github](https://github.com/alibaba-damo-academy/WorldVLA) · [paper](https://arxiv.org/abs/2506.21539)
- [World-Env](https://arxiv.org/abs/2509.24948) · [World-VLA-Loop](https://arxiv.org/abs/2602.06508) · [FLARE](https://arxiv.org/abs/2505.15659) · [UWM](https://weirdlabuw.github.io/uwm/) · [DUST](https://arxiv.org/abs/2510.27607)
- [NVIDIA Cosmos](https://www.nvidia.com/en-us/ai/cosmos/) · [世界-动作模型综述](https://developer.nvidia.com/blog/pretrained-to-imagine-fine-tuned-to-act-the-rise-of-world-action-models/) · [Isaac GR00T github](https://github.com/NVIDIA/Isaac-GR00T) · [Isaac Lab](https://isaac-sim.github.io/IsaacLab/)
- [AWS edge-to-cloud 物理 AI](https://aws.amazon.com/blogs/opensource/building-intelligent-physical-ai-from-edge-to-cloud-with-strands-agents-bedrock-agentcore-claude-4-5-nvidia-gr00t-and-hugging-face-lerobot/) · [Voyager](https://github.com/MineDojo/Voyager)
- [Jetson Edge AI 指南](https://developer.nvidia.com/blog/getting-started-with-edge-ai-on-nvidia-jetson-llms-vlms-and-foundation-models-for-robotics/) · [VLA 对比 2026](https://www.roboticscenter.ai/tools/vla-models-comparison) · [分层 grounding](https://arxiv.org/html/2604.05614v1)
