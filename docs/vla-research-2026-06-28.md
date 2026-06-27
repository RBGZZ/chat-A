# VLA（Vision-Language-Action）模型调研

**日期**: 2026-06-28 | **目的**: 为 chat-A（小雪）储备具身智能（Embodied AI）的"动作生成"核心知识。本项目坚持嵌入式部署，终极方向是**从纯语音陪伴 Agent 走向具身智能体**——VLA 正是把"感知 + 语言"接到"物理动作"的那一层。

> 配套阅读：[世界模型调研](world-model-research-2026-06-27.md)（VLA 的"想象/规划"上游）、[VRChat 接入 + 感知层](stage-goal-vrc-perception-2026-06-27.md)（VLA 的"感知"上游）。三者构成 **感知 → 世界模型 → 动作** 的完整具身闭环。

---

## 一、一句话定义

**VLA** = 把视觉（Vision）与语言指令（Language）映射为**机器人可执行连续动作**（Action）的端到端基础模型。它在 VLM（视觉-语言模型）的"看 + 懂"之上，再长出一个**动作头（action expert）**，输出关节/末端执行器的连续控制量。

一句话谱系：**LLM**（懂语言）→ **VLM**（看 + 懂）→ **VLA**（看 + 懂 + 动）。

对 chat-A 而言：小雪现在是"感知 + 对话"，输出动作是 TTS 语音 / chatbox 文字 / Avatar 参数；**具身化后输出动作变成电机指令**。VLA 的核心架构思想（双系统、动作专家、跨本体）几乎逐条对应 chat-A 已有的设计接缝——这是本调研最有价值的部分（见 §五）。

---

## 二、核心模型谱系（2022 → 2026）

### 2.1 起源：Google RT 系列

| 模型 | 时间 | 突破 |
|------|------|------|
| **RT-1** | 2022 | Robotics Transformer，把机器人控制当序列建模，130k 真机演示 |
| **RT-2** | 2023 | 首个真正"VLA"：在 VLM（PaLI-X/PaLM-E）上做 co-fine-tune，动作离散成 token 与文本同表，涌现出对未见物体的语义泛化 |

**意义**：证明"把动作当 token 接到 VLM 上"可行，互联网知识能迁移到机器人动作。

### 2.2 开源基线：OpenVLA / Octo

| 模型 | 规模 | 特点 |
|------|------|------|
| **OpenVLA** | 7B | 开源 SOTA 基线，Prismatic VLM + Llama2 骨干，Open X-Embodiment 数据训练；社区微调起点 |
| **Octo** | 27M–93M | 轻量 Transformer 策略，扩散动作头，可灵活换观测/动作空间 |

### 2.3 流匹配路线：π0 / π0-FAST / π0.5（Physical Intelligence）

**π0 是当前最有影响力的设计范式**：

- **骨干**：PaliGemma 3B VLM（看 + 懂）
- **动作头**：独立的 **action expert**，用 **flow matching（流匹配）** 生成连续动作，而非离散 token——更平滑、更精确、适合灵巧操作
- **跨本体（cross-embodiment）**：~10000 小时、7 种机器人构型、68 类任务 + OXE 开源数据预训练
- **训练配方**：照搬 LLM 的"预训练 → 后训练"两段式
- **π0-FAST**：用 FAST 动作 tokenizer 把自回归推理提速一个量级
- **π0.5**：加开放世界泛化，能进没见过的真实家庭做任务
- 开源实现 **openpi**（github.com/Physical-Intelligence/openpi）

**关键洞察**：动作头与 VLM 解耦——VLM 处理任意相机图像，flow-matching 头输出任意动作空间。这就是"**硬件无关、本体可换**"，对 chat-A 的多形态部署（PC / 树莓派机器人 / VRChat Avatar）是直接的架构启示。

### 2.4 双系统人形基础模型：GR00T N1（NVIDIA）/ Helix（Figure AI）

**这是与 chat-A 最对得上的架构**——显式的 **System 1 / System 2 快慢双系统**（Kahneman 双过程理论，chat-A 已采用，见世界模型调研建议 5）：

| | System 2（慢/想） | System 1（快/动） |
|--|------------------|-------------------|
| **角色** | VLM 高层规划：看场景 + 读指令 → 拆解子任务、生成轨迹意图 | 动作专家：低层控制，灵巧 + 平滑 |
| **实现** | 大 VLM 骨干，低频 | Diffusion Transformer（DiT）/ flow-matching，高频 |
| **频率** | 几 Hz | GR00T N1 达 **120Hz** 去噪出连续电机动作 |

- **GR00T N1**（2025-03，NVIDIA）：开源人形通用基础模型，冻结/微调 MLLM 骨干 + DiT 流匹配动作专家
- **Helix**（2025-02，Figure AI）：首个能**高频控制人形整个上半身**（臂、手、躯干、头、手指）的通用 VLA
- 学术变体：**Fast-in-Slow**（把快操作统一进慢推理同一模型）、**Hume**（给 VLA 引入 System-2 思考）、**异步快慢全身操作**

### 2.5 世界模型 × VLA：GigaBrain-0

**GigaBrain-0**：世界模型驱动的 VLA——用世界模型生成/增广数据与做想象 rollout，再训练动作策略。这正是 chat-A 两份调研（[世界模型](world-model-research-2026-06-27.md) + 本篇）的交汇点：**世界模型负责"如果这样动会怎样"的预演，VLA 负责把决策落成动作**。

---

## 三、边缘 / 嵌入式 VLA（与 chat-A 嵌入式目标强相关）⭐

具身落到树莓派级硬件，大模型 VLA 跑不动。2025–2026 出现一批专为**便宜硬件 + 低延迟**设计的小 VLA：

| 模型 | 规模 / 资源 | 关键事实 |
|------|------------|----------|
| **SmolVLA**（HuggingFace, 2025-06）| ~**2GB VRAM**, **<100ms** 延迟 | 单 GPU 可训，消费级 GPU 甚至 **CPU** 可部署；LIBERO 仿真 >87%，真机社区数据 ~78%；可与其他推理负载共享一张卡 |
| **TinyVLA**（RAL 2025）| 轻量 | 针对"VLA 推理慢 + 需海量机器人预训练"两大痛点，数据高效、推理快 |
| **NanoVLA** | nano 级 | 路由解耦视觉-语言理解，做"纳米级"通用机器人策略 |
| **Lite VLA**（2025-11）| **CPU-bound 边缘** | 直接面向 **CPU 边缘机器人**的高效 VLA 控制 |
| **QuantVLA** | 量化 | 尺度校准的**训练后量化（PTQ）**，把大 VLA 压到可部署 |
| **A1** | 开源透明 | 自适应、高效的"截断式（truncated）"VLA |

**对 chat-A 的直接意义**：和语音管线一样的"嵌入式轻量化"思路（[[embedded-lightweight-strategy]]）——SmolVLA / TinyVLA / NanoVLA / Lite VLA 是树莓派具身的现实候选；走 ONNX/量化（QuantVLA 思路）；动作头是真瓶颈，与"TTS 是语音真瓶颈"同构。

---

## 四、关键术语表

| 术语 | 定义 |
|------|------|
| **VLA** | Vision-Language-Action，把视觉+语言指令映射为连续动作的基础模型 |
| **Action Expert / 动作专家** | 接在 VLM 骨干后的独立动作生成头，与语言理解解耦 |
| **Flow Matching / 流匹配** | π0/GR00T 用的连续动作生成法，比离散 token 更平滑精确；扩散的近亲 |
| **Diffusion Policy** | 用扩散模型去噪生成动作序列的策略 |
| **Action Chunking** | 一次预测一段动作序列（而非单步），降频、增平滑、抗误差累积 |
| **Cross-Embodiment / 跨本体** | 用多种机器人构型的混合数据训练，使一个模型迁移到不同身体 |
| **OXE (Open X-Embodiment)** | 跨机构跨机器人的开源动作数据集，VLA 预训练主力 |
| **System 1 / System 2** | 快直觉动作头（高频）/ 慢审慎规划 VLM（低频）双系统 |
| **Embodiment Gap** | 训练本体与部署本体不一致导致的性能损失 |
| **Sim2Real** | 仿真训练迁移到真机的鸿沟与技术 |
| **Affordance / 可供性** | 物体"可被怎样操作"的语义（可抓、可推…） |
| **Physical AI / 具身智能** | 能在物理世界感知-决策-行动的 AI，VLA + 世界模型是其两大支柱 |

---

## 五、对 chat-A 的实用判断：VLA 是"接缝"，不是"现在就训" ⭐⭐

### 核心判断

chat-A 当前是**纯语音陪伴 Agent**，无操作任务、无机械臂。**现阶段不训练、不引入 VLA 本体**——那是南辕北辙。VLA 的价值在于：**它的架构思想与 chat-A 已有设计高度同构，应作为"具身化"的预留接缝 day-1 想清楚**，避免未来大改爆炸半径失控（[[chat-a-modularity-principle]]）。

### 接缝 1：双系统架构——已经在做，VLA 给出动作侧的成熟范式

chat-A 的世界模型调研已采纳 System 1 / System 2（Talker-Reasoner，建议 5）。VLA 把这套搬到**动作生成**侧并给出工程答案：

```
System 2（慢，VLM/LLM 规划）      System 1（快，动作专家）
chat-A 现状：                     chat-A 现状：
  LLM 决策语气/话题/主动性    →     TTS 流式朗读 / chatbox / Avatar 参数
chat-A 具身后：                   chat-A 具身后：
  同一个 LLM/VLM 规划意图     →     flow-matching 动作头 → 电机（高频）
```

**启示**：把"动作输出"抽象成一个 **ActionPort 接缝**——今天背后是 TTS/Avatar，明天可换成 VLA 动作专家，规划层不变。这与语音管线的 Port/Factory 接缝（[[chat-a-runtime-architecture]]）完全同构。

### 接缝 2：跨本体 = chat-A 的"一个大脑，多种身体"

π0 的"硬件无关、本体可换"对应 chat-A 的"行为即配置"（[[chat-a-dev-principles]]）：**同一个小雪人格 + 记忆 + 世界模型，驱动不同身体**——PC 扬声器、树莓派桌面机器人、VRChat Avatar。把"身体"建模成可插拔的 Embodiment 适配器，是从陪伴 Agent 到具身智能体的平滑路径。

### 接缝 3：世界模型 × VLA 闭环

GigaBrain-0 印证：**世界模型（"如果这样动会怎样"的社会/物理预演）→ VLA（落成动作）→ 真实反馈 → 回写记忆**。chat-A 的情感闭环（CTEM 模式，世界模型建议 4）就是这个闭环的"社会版"；具身后增加物理动作维度即可复用同一闭环骨架（[[chat-a-traceability-principle]]：全链路可追溯）。

### 接缝 4：嵌入式落地走小 VLA

延续 [[embedded-lightweight-strategy]]：树莓派具身别碰 7B OpenVLA / π0，盯 **SmolVLA / TinyVLA / NanoVLA / Lite VLA**；ONNX + 量化（QuantVLA）；与语音感知小模型（CED-tiny / emotion2vec / MobileCLIP，见 VRC 调研）共卡共栈。

### 现阶段动作清单（轻、只埋接缝）

- [ ] 在 runtime 设计里把"动作输出"抽象为 **ActionPort**（语音/文字/Avatar 是其当前实现）——为未来电机动作头留位
- [ ] 文档层把 **Embodiment 适配器** 概念写进 canonical 的"行为即配置"接缝，标注 P4/远期
- [ ] 关注 **SmolVLA / openpi / GR00T N1** 三个开源锚点（社区活跃、可复现）
- [ ] 不做：训练任何 VLA、引入机械臂仿真（MuJoCo/Isaac）、采集机器人数据——全部远期

---

## 六、不做推荐（过度设计）

| 概念 | 为什么现在不做 |
|------|---------------|
| 训练/微调 π0 / OpenVLA / GR00T | 需机器人硬件 + 海量动作数据；chat-A 无操作任务，纯南辕北辙 |
| Isaac Sim / MuJoCo / Genesis 仿真 | 面向灵巧操作策略训练，当前零相关 |
| 接机械臂 / 灵巧手 | 没有具身硬件之前是空中楼阁；先把接缝留好 |
| 自建跨本体数据集 / OXE 规模数据 | 巨型工程，远期且依赖硬件 |
| 7B 级 VLA 上树莓派 | 跑不动；要上也是 SmolVLA/Lite VLA 级别 |

---

## 七、最值得跟进的资源（按对 chat-A 的实用价值排序）

1. **SmolVLA**（HuggingFace）——同生态、可 CPU 跑、嵌入式具身的最现实锚点 → 精读 + 关注 LeRobot
2. **π0 / openpi**（Physical Intelligence）——flow-matching 动作专家 + 跨本体范式，架构教科书
3. **GR00T N1**（NVIDIA）——双系统 + DiT 动作专家开源白皮书，与 chat-A System1/2 直接对照
4. **awesome-physical-ai**（github.com/keon/awesome-physical-ai）——VLA + 世界模型 + 具身 综合书单，持续跟踪
5. **Lite VLA / NanoVLA / QuantVLA**——CPU 边缘部署与量化，树莓派落地时再深读

---

## 八、参考链接

- VLA 综述（Embodied AI）: https://arxiv.org/pdf/2405.14093
- VLA 综述（Embodied Manipulation）: https://www.themoonlight.io/en/review/survey-of-vision-language-action-models-for-embodied-manipulation
- Large VLM-based VLA Survey (2025-08): https://arxiv.org/pdf/2508.13073
- Wikipedia: Vision-language-action model: https://en.wikipedia.org/wiki/Vision-language-action_model
- π0: A Vision-Language-Action Flow Model: https://www.pi.website/download/pi0.pdf
- π0 / π0-FAST（HuggingFace blog）: https://huggingface.co/blog/pi0
- openpi（Physical Intelligence 开源）: https://github.com/Physical-Intelligence/openpi
- GR00T N1 白皮书: https://d1qx31qr3h6wln.cloudfront.net/publications/GR00T%20N1%20Whitepaper.pdf
- SmolVLA: https://arxiv.org/abs/2506.01844
- SmolVLA 边缘部署指南: https://www.spheron.network/blog/smolvlm-smolvla-gpu-cloud-edge-ai-robotics/
- TinyVLA: https://tiny-vla.github.io/
- NanoVLA: https://arxiv.org/pdf/2510.25122
- Lite VLA（CPU 边缘）: https://arxiv.org/html/2511.05642v1
- QuantVLA（量化）: https://arxiv.org/pdf/2602.20309
- Fast-in-Slow（双系统统一）: https://arxiv.org/html/2506.01953v1
- Hume（System-2 思考）: https://arxiv.org/html/2505.21432
- GigaBrain-0（世界模型驱动 VLA）: https://arxiv.org/pdf/2510.19430
- LeRobot VLA 策略教程: https://learnopencv.com/vision-language-action-models-lerobot-policy/
- awesome-physical-ai: https://github.com/keon/awesome-physical-ai
