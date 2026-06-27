# 附录 B：VLA（Vision-Language-Action）开源方案可落地性调研

> 子代理调研报告（2026-06-28），主文档见 [embodiment-architecture-2026-06-28.md](embodiment-architecture-2026-06-28.md)。面向 chat-A（TS/Node 实时语音陪伴 Agent，走向具身、坚持嵌入式、先 VTuber 后真机）。

> 一句话结论：**现阶段应"埋接缝"而非"试跑"**。VLA 真正能 clone 跑通的开源生态已成熟，但它解决的是"机器人关节动作"问题，而 chat-A 当前缺机器人硬件、动作空间是虚拟形象——直接接 VLA 是错配。值得现在就锁定的开源锚点是 **LeRobot / SmolVLA 生态**，并以 sidecar（Python 进程 + gRPC/HTTP）方式与 TS 主栈共存。

---

## 1. 可部署的开源 VLA 仓库地图

### 1.1 总览表

| 仓库 / 模型 | URL | Star | License | 参数量 | 推理显存 | 推理频率（A100 / Jetson Orin） | 预训练权重 | 技术栈 | 成熟度 |
|---|---|---|---|---|---|---|---|---|---|
| **LeRobot**（枢纽库） | [github.com/huggingface/lerobot](https://github.com/huggingface/lerobot) | **25.3k** | Apache-2.0 | 多策略托管 | 取决于策略 | 取决于策略 | 是（HF Hub） | PyTorch | 极活跃，事实标准 |
| **SmolVLA** | [hf.co/lerobot/smolvla_base](https://huggingface.co/lerobot/smolvla_base) · [arXiv 2506.01844](https://arxiv.org/abs/2506.01844) | 随 LeRobot | Apache-2.0 | **450M**（含编码器约535M） | 消费级/单卡可跑 | ~5–25Hz / ~2–15Hz* | 是 | PyTorch | 高，边缘首选 |
| **openpi (π0/π0-FAST/π0.5)** | [github.com/Physical-Intelligence/openpi](https://github.com/Physical-Intelligence/openpi) | **12.5k** | Apache-2.0 | π0 ~3B | >8GB（推理）；>22.5GB LoRA；>70GB 全量 | ~10–15Hz / ~3–8Hz | 是（pi05-base/droid/libero） | JAX + PyTorch（2025-09 起） | 高，前沿基础模型 |
| **OpenVLA** | [github.com/openvla/openvla](https://github.com/openvla/openvla) | ~数k | **代码 MIT；权重继承 Llama-2 社区许可** | **7.4B** | ~16GB（推理） | 5–8Hz / 1.5–3Hz（A6000 单步292ms） | 是 | PyTorch | 高，学术基线 |
| **OpenVLA-OFT** | [github.com/moojink/openvla-oft](https://github.com/moojink/openvla-oft) | — | 同上 | 7B | 同上 | 显著提速（优化微调） | 是 | PyTorch | 中高 |
| **Octo** | [github.com/octo-models/octo](https://github.com/octo-models/octo) · [octo-models.github.io](https://octo-models.github.io/) | — | 开源（MIT/Apache，rail-berkeley） | **27M / 93M** | 很低 | 40+Hz / 15–20Hz | 是（octo-small/base） | **JAX** | 中（2024，维护放缓） |
| **NVIDIA Isaac GR00T N1.x** | [github.com/NVIDIA/Isaac-GR00T](https://github.com/NVIDIA/Isaac-GR00T) | **7.4k** | **代码 Apache-2.0；权重 NVIDIA Open Model License** | N1.5: 3B+550M；N1.7: Cosmos-Reason2-2B + DiT | **16GB+（推理）；40GB+（微调，默认~25GB）** | 未明示 / 支持 Jetson AGX Thor/Orin | 是 | PyTorch | 高，人形/双系统 |
| **TinyVLA** | [arXiv 2409.12514](https://arxiv.org/pdf/2409.12514) | — | 论文+代码 | 紧凑（轻量扩散头） | 低 | 快 | 部分 | PyTorch | 中（偏研究） |
| **NanoVLA** | [arXiv 2510.25122](https://arxiv.org/html/2510.25122v1) | — | 论文 | **OpenVLA 的 ~2%** | 极低 | 高频控制 | 待开源 | — | 研究阶段 |
| **QuantVLA** | [arXiv 2602.20309](https://arxiv.org/pdf/2602.20309) | — | 论文 | PTQ 框架（不改架构） | 量化降显存 | — | N/A（套在现有 VLA 上） | — | 研究阶段 |
| **Lite VLA / LiteVLA-Edge** | [arXiv 2511.05642](https://arxiv.org/html/2511.05642v1) · [2603.03380](https://arxiv.org/html/2603.03380v1) | — | 论文 | 紧凑 | CPU/Jetson 可跑 | 150ms≈6.6Hz（Jetson Orin, 4-bit GGUF） | 部分 | llama.cpp/C++ | 研究→工程化 |

\* SmolVLA 频率口径在不同来源有出入：原始论文/官方约 5Hz(A100)、2Hz(Jetson AGX Orin)；第三方对比表给出 25Hz/10–15Hz（依 chunk 与异步策略不同）。

### 1.2 LeRobot —— 关键枢纽（务必读懂）

[LeRobot](https://github.com/huggingface/lerobot)（HuggingFace，Apache-2.0，25.3k★）是当前机器人学习的**事实标准库与生态枢纽**。它不是单一模型，而是：

- **统一的 PyTorch 策略框架 + 数据格式（LeRobotDataset）+ HF Hub 权重托管**。
- 内置的**模仿学习策略**：ACT、Diffusion Policy、VQ-BeT、Multitask DiT。
- 内置的**VLA 模型**：π0、π0-FAST、π0.5、GR00T N1.5、SmolVLA、XVLA、EO-1、MolmoAct2、WALL-OSS（[v0.5.0 发布说明](https://huggingface.co/blog/lerobot-release-v050)）。
- **Robot 类接口**把控制逻辑与硬件解耦；并提供 **Policy Server / Robot Client 异步推理架构**（[策略部署文档 lerobot-rollout](https://huggingface.co/docs/lerobot/main/inference)）——即"模型在一个进程/远端推理，机器人客户端解耦执行"。**这个 sidecar 模式正是 TS 主栈接 Python VLA 的天然接缝。**
- 关键增强：**Real-Time Chunking (RTC)**、**异步推理**（动作执行与观测/预测并行，约 30% 更快、2× 吞吐）。

> 对 chat-A 的意义：要跟 VLA，几乎一定是通过 LeRobot 这层抽象，而非裸接单个模型仓库。它把"换 policy = 换一个类"做成了模块化——与 chat-A 的"模块级可重写/Factory 接缝"原则同构。

### 1.3 openpi（Physical Intelligence）

[openpi](https://github.com/Physical-Intelligence/openpi)（Apache-2.0，12.5k★）是 π 系列的官方开源实现与权重。2025-09 起补齐 **PyTorch** 训练/推理（原为 JAX）；π0.5 权重 + 微调代码已于 2025-09 开源（[Chelsea Finn 公告](https://x.com/chelseabfinn/status/1965191903978422740)）：

- **π0**：flow-matching 扩散 VLA，~3B；π0-FAST：自回归 + FAST 动作 tokenizer；**π0.5**：开放世界泛化（pi05-base/droid/libero）。
- 预训练于 **10k+ 小时机器人数据**；推理 **>8GB 显存**（RTX 4090 即可，约 15Hz @24GB），LoRA 微调 >22.5GB，全量 >70GB。
- Apache-2.0 商用友好，是目前**最强的可商用开源 VLA 基础模型**之一。

### 1.4 OpenVLA / Octo

- **OpenVLA**（7.4B，[repo](https://github.com/openvla/openvla)）：首个"完全开源、宣称可商用"的 VLA。**注意 license 双层**：代码 MIT，但权重基于 Llama-2，受 **Llama 社区许可**约束——商用前需核对。基于 RT-X（970K 轨迹/22 形态），LIBERO 74.9%；A6000 单步 292ms（~3Hz），偏重。**OpenVLA-OFT**（[repo](https://github.com/moojink/openvla-oft)）专门优化速度与成功率。
- **Octo**（27M/93M，[repo](https://github.com/octo-models/octo)）：UC Berkeley 等的 Transformer 扩散策略，800K OXE 轨迹，支持语言/目标图像。**极轻、Jetson 上 15–20Hz**，但用 **JAX**、且 2024 年后维护放缓——适合作"轻量参照"而非主线。

### 1.5 NVIDIA Isaac GR00T N1.x

[Isaac-GR00T](https://github.com/NVIDIA/Isaac-GR00T)（7.4k★）是人形机器人基础模型，**双系统 VLA** 的开源代表：

- N1.5 = 3B VLM 主干 + 550M 扩散动作头；**N1.7** = Cosmos-Reason2-2B VLM + DiT 动作解码器（[N1.7 介绍](https://huggingface.co/blog/nvidia/gr00t-n1-7)）。
- **License 关键**：代码 Apache-2.0，**权重为 NVIDIA Open Model License**（N1 早期曾是"非商用研究"，需逐版本核对商用条款）。
- 推理 16GB+ 显存，可部署 **Jetson AGX Thor / Orin**（[Seeed 实操：微调 + Jetson Thor 部署](https://wiki.seeedstudio.com/fine_tune_gr00t_n1.5_for_lerobot_so_arm_and_deploy_on_jetson_thor/)）。微调默认 ~25GB，建议 40GB+，可用 LoRA / `--no-tune_diffusion_model` 降配。

### 1.6 边缘/小模型阵营

- **SmolVLA**（见 1.2、§3）：450M，Apache-2.0，**唯一"为消费级/边缘而生且生态活跃"**的开源 VLA。SigLIP 视觉 + SmolLM2-135M + flow-matching 动作专家；单卡 1–2h 可微调；真实任务 78.3% 成功率，超过从零训的 ACT 和微调的 π0（[官方博客](https://huggingface.co/blog/smolvla)、[arXiv](https://arxiv.org/abs/2506.01844)）。
- **TinyVLA / NanoVLA**：把"重语义推理"与"轻高频控制"解耦；NanoVLA 仅用 OpenVLA **2% 参数**达 SOTA（[arXiv 2510.25122](https://arxiv.org/html/2510.25122v1)）。偏研究，权重未完全开放。
- **QuantVLA**：训练后量化框架（选择性量化 + 注意力温度匹配），**套在现有 VLA 上**降显存，不改架构（[arXiv 2602.20309](https://arxiv.org/pdf/2602.20309)）。
- **Lite VLA / LiteVLA-Edge / vla.cpp**：工程化边缘运行时方向（4-bit GGUF + llama.cpp，CPU/Jetson 可跑）。可参考的 awesome 清单：[awesome-efficient-vla](https://github.com/guanweifan/awesome-efficient-vla)。

---

## 2. "Agent 大脑"如何接到 VLA

现实中 LLM/Agent 规划层与 VLA 动作层有三种主流对接模式，**chat-A 已有的"事件总线 + 优先级回合调度 + System2/System1 思路"与第一种天然契合**。

| 模式 | 机制 | 代表 | 开源可得 |
|---|---|---|---|
| **A. 双系统（S2 规划 + S1 动作专家）** | 慢思考 VLM 出潜在语义/子目标（~7–9Hz），快动作专家出连续控制（200Hz/10ms） | **GR00T**（S2 VLM + S1 扩散，10ms）、**Figure Helix**（S2 7B VLM @7–9Hz + S1 @200Hz） | **GR00T 开源**；Helix 闭源（[Figure Helix](https://www.figure.ai/news/helix)） |
| **B. LLM 出子目标/语言指令喂 VLA** | LLM 把长程任务拆成语言子指令，逐条作为 VLA 的 instruction | 大量层级式工作（[RePLan](https://arxiv.org/pdf/2401.04157)、Agent-as-Planner/VLA-as-Skill） | 多为论文级开源 |
| **C. 技能库（Voyager 范式）** | LLM 当高层规划器 + 可增长的技能库 + 低层控制器，环境反馈进 prompt | **Voyager**（GPT-4 + Mineflayer + 技能库，[arXiv 2305.16291](https://arxiv.org/html/2305.16291)）、SELF-VLA | Voyager 开源 |

要点：
- **A（双系统）是产业主线**，也是 chat-A 走向具身后的目标形态——其"S2=认知/规划，S1=动作专家"恰好能复用 chat-A 现有的 LLM 认知层 + 事件总线。开源标杆就是 **GR00T**（可 clone 跑通），闭源标杆是 Helix。
- **B/C 不需要端到端 VLA 权重**，用纯 LLM + 规则/小技能库即可起步——**这正是 chat-A 在 VTuber 阶段应采用的模式**（LLM 出"挥手/微笑/转头"等子目标，喂给确定性的动作执行器，而非 VLA）。

---

## 3. 边缘部署现实（6GB 显存 / Jetson / 树莓派）

诚实结论：**树莓派级别现阶段跑不动严肃 VLA；6GB 显存能跑小模型但要靠重度量化 + 异步 + 动作分块；Jetson Orin/Thor 才是 VLA 边缘的现实底座。**

实测数据点：
- **SmolVLA**：A100 ~5Hz，**Jetson AGX Orin ~2Hz**（原始口径）。靠 **action chunking**（一次预测 10–20 步、底层 50Hz 执行）+ **异步推理**（执行与预测并行）才能可用；200–500ms/次推理 = 机器人按 0.2–0.4s 计划动作，**够用于操作类，但反应类（接、插）吃力**（[SmolVLA arXiv](https://arxiv.org/html/2506.01844v1)）。
- **LiteVLA-Edge**：Jetson Orin 上 **4-bit GGUF + llama.cpp**，端到端 **150ms ≈ 6.6Hz**，VLA"慢思考"6.6Hz 的同时底层控制器维持 **100Hz** 心跳（[arXiv 2603.03380](https://arxiv.org/html/2603.03380v1)）。
- **JetPack 7.1 的 TensorRT Edge-LLM SDK**：C++ 运行时，避开 Python 解释器与 GC 停顿，给实时调度可预测延迟（[NVIDIA 博客](https://developer.nvidia.com/blog/accelerate-ai-inference-for-edge-and-robotics-with-nvidia-jetson-t4000-and-nvidia-jetpack-7-1/)）。
- 现状栈：**ONNX/TensorRT/GGUF(llama.cpp) + INT4/INT8 量化（QuantVLA 等）+ 双系统拆频**。统一运行时在成形（[vla.cpp](https://arxiv.org/html/2606.08094)）。
- 控制频率经验阈：端到端 VLA 控制环常以 **24Hz** 为目标，底层稳定回路 **100Hz**——VLA 只负责"慢决策"，**不**直接顶高频伺服。

> 对照 chat-A 的"TTS 才是真瓶颈、嵌入式优先被验证"记忆：VLA 比 TTS 更重一个量级。6GB/树莓派阶段，**VLA 不进主链路**，只在 Jetson 级真机上以 sidecar 形式试跑。

---

## 4. 诚实评估：能跑通的 vs 只是论文

| 维度 | 现实 |
|---|---|
| **真能 clone 跑通 + 有权重** | ✅ **LeRobot 全家桶、SmolVLA、openpi(π0/π0.5)、OpenVLA(-OFT)、Octo、GR00T N1.x** —— 都有权重、有微调脚本、有部署文档。 |
| **缺权重/只是论文** | ⚠️ **NanoVLA、QuantVLA、多数 Lite/TinyVLA 变体、vla.cpp** —— 偏研究，权重/代码未必完整开放，复现成本高。 |
| **License 商用陷阱** | OpenVLA 权重受 **Llama-2 社区许可**（非纯 MIT）；GR00T 权重受 **NVIDIA Open Model License**（逐版本核对）。**最干净可商用：SmolVLA / openpi / LeRobot 本体（均 Apache-2.0）**。 |
| **数据/微调门槛（致命点）** | VLA 要的是**机器人演示数据**：微调通常需 **300–1200 条 episode**（leader-follower 遥操采集），LIBERO 等仿真每套 500 条。**chat-A 没有机器人硬件 = 采不到真实演示数据。** |

**"没有机器人硬件"对 chat-A 意味着什么（核心诚实点）：**
1. 无法采集真实遥操数据 → 无法把任何 VLA 微调到自己的形态/任务。
2. 只能走两条替代路：**(a) 纯仿真**（LIBERO / Isaac Lab / Isaac GR00T 合成数据）做学习与验证；**(b) 直接用预训练 VLA 的零样本/语言指令能力**，不微调。
3. 而 chat-A 当前阶段的"动作"是**虚拟形象控制**（VRChat OSC 参数、Live2D 表情/口型、动画触发），**这不是关节力矩空间**——严肃机器人 VLA 在这里**用不上**，属于错配。VTuber 的"动作"用 LLM 出子目标 + 确定性动作库即可（§2 的 B/C 模式）。

---

## 5. 落到 chat-A：埋接缝，还是试跑？

### 结论：**埋接缝（不试跑 robotics VLA）**

理由链：
1. **动作空间错配**：VTuber 阶段的 action = 表情/手势/Live2D/VRChat OSC，不是机器人关节。此时引入端到端 VLA 既无数据可训、也无对应输出空间，纯负担。
2. **无硬件 = 无数据**：VLA 的门槛 80% 在演示数据，chat-A 现在跨不过去。
3. **嵌入式现实**：6GB/树莓派跑不动严肃 VLA；真机阶段也得是 Jetson 级 + sidecar。
4. **但接缝必须现在埋**：与 chat-A "Day-1 埋 Factory 接缝、模块级可重写、行为即配置"的既有原则完全一致。

### 该埋什么接缝（具体）

- **`ActionPort` 抽象**（类比已有的 STT/TTS Port）：上层 LLM/认知层产出**与执行器无关的"意图/子目标"**（如 `wave_hand`、`look_at(user)`、`emote(happy)`、未来 `pick(cup)`），下层实现可替换：
  - VTuber 阶段实现 = **VRChat OSC / Live2D 适配器**（确定性映射，无需 VLA）。
  - 真机阶段实现 = **VLA sidecar 适配器**（LeRobot policy-server 客户端）。
- **沿用"双系统"接缝**：把 chat-A 现有 LLM 认知层定位为 **System 2（慢/规划）**，未来的动作专家为 **System 1**——这与 GR00T/Helix 同构，迁移代价最小。

### 最值得跟的开源锚点：**LeRobot / SmolVLA 生态**

- 生态活跃度断层第一（LeRobot 25.3k★、Apache-2.0、HF 持续投入、几乎所有新 VLA 都进 LeRobot）。
- SmolVLA 是唯一"边缘友好 + 可商用 + 一线维护"的开源 VLA，与 chat-A 的嵌入式/伴侣定位最贴。
- LeRobot 自带 **Policy Server / Robot Client 异步架构**，等于官方背书的 sidecar 模式。
- 次要关注：**openpi（π0.5）**作为"上限参照"，**GR00T N1.x** 作为"双系统 + Jetson 部署"的工程范本。

### Python VLA 与 TS/Node 主栈如何共存（sidecar / gRPC）

VLA 生态 100% 是 Python，**不要试图移植到 Node**。推荐架构：

```
[TS/Node 主栈: 语音/认知/事件总线/回合调度]
        │  ActionPort（意图/子目标，语言或结构化）
        ▼
   gRPC / HTTP（本机或局域，protobuf 定义动作契约）
        ▼
[Python VLA sidecar 进程: LeRobot policy-server + SmolVLA/π0/GR00T]
        │
        ▼
   执行器（VTuber: OSC/Live2D；真机: 电机驱动）
```

- **接口选 gRPC**（强类型契约、低延迟、跨语言）或简单 HTTP（LeRobot policy-server 即此模式）；动作以 protobuf 定义，**与"行为即配置/可追溯"原则对齐**（每条意图可打 trace，复用现有 `[vtrace]` 范式）。
- sidecar 进程独立崩溃/重启不拖垮主栈，**符合 chat-A 的优雅降级与爆炸半径可控原则**：VLA 不可用时 ActionPort 退化为"无动作/规则动作"，语音陪伴主链路不受影响。
- 部署上：VTuber 阶段 sidecar 可以根本不存在（OSC 适配器是纯 TS）；真机阶段在 Jetson 上拉起 Python sidecar。

### 建议的最小动作（不写 VLA 代码，只埋缝）

1. 在设计文档/接缝层定义 `ActionPort`（意图 schema + Factory，参照现有 STT/TTS Port 写法）。
2. VTuber 阶段先落 **VRChat OSC / Live2D 适配器**（纯 TS，确定性），验证"LLM 子目标 → 动作"闭环。
3. 文档层记录 VLA 锚点 = **LeRobot/SmolVLA + sidecar(gRPC)**，列为真机阶段的待跑项（Tier 靠后），不入当前迭代。

---

## 来源

- [LeRobot GitHub](https://github.com/huggingface/lerobot) · [v0.5.0 发布](https://huggingface.co/blog/lerobot-release-v050) · [策略部署/推理文档](https://huggingface.co/docs/lerobot/main/inference) · [DeepWiki](https://deepwiki.com/huggingface/lerobot)
- [SmolVLA 官方博客](https://huggingface.co/blog/smolvla) · [arXiv 2506.01844](https://arxiv.org/abs/2506.01844) · [HF 权重](https://huggingface.co/lerobot/smolvla_base) · [LearnOpenCV 解析](https://learnopencv.com/smolvla-lerobot-vision-language-action-model/)
- [openpi GitHub](https://github.com/Physical-Intelligence/openpi) · [Open Sourcing π0](https://www.pi.website/blog/openpi) · [π0.5 开源公告](https://x.com/chelseabfinn/status/1965191903978422740) · [open-pi-zero 复刻](https://github.com/allenzren/open-pi-zero)
- [OpenVLA GitHub](https://github.com/openvla/openvla) · [OpenVLA-OFT](https://github.com/moojink/openvla-oft) · [arXiv 2502.19645](https://arxiv.org/abs/2502.19645)
- [Octo 主页](https://octo-models.github.io/) · [GitHub](https://github.com/octo-models/octo) · [arXiv 2405.12213](https://arxiv.org/abs/2405.12213) · [HF octo-base](https://huggingface.co/rail-berkeley/octo-base)
- [Isaac-GR00T GitHub](https://github.com/NVIDIA/Isaac-GR00T) · [N1.7 介绍](https://huggingface.co/blog/nvidia/gr00t-n1-7) · [NVIDIA 技术博客 N1](https://developer.nvidia.com/blog/accelerate-generalist-humanoid-robot-development-with-nvidia-isaac-gr00t-n1/) · [Seeed: 微调+Jetson Thor 部署](https://wiki.seeedstudio.com/fine_tune_gr00t_n1.5_for_lerobot_so_arm_and_deploy_on_jetson_thor/)
- [Figure Helix](https://www.figure.ai/news/helix) · [Helix 架构(S1/S2)](https://x.com/TheHumanoidHub/status/1892677115537195416)
- [Voyager arXiv 2305.16291](https://arxiv.org/html/2305.16291) · [RePLan](https://arxiv.org/pdf/2401.04157)
- 边缘部署：[LiteVLA-Edge 2603.03380](https://arxiv.org/html/2603.03380v1) · [vla.cpp 2606.08094](https://arxiv.org/html/2606.08094) · [JetPack 7.1 TensorRT Edge-LLM](https://developer.nvidia.com/blog/accelerate-ai-inference-for-edge-and-robotics-with-nvidia-jetson-t4000-and-nvidia-jetpack-7-1/) · [NanoVLA 2510.25122](https://arxiv.org/html/2510.25122v1) · [QuantVLA 2602.20309](https://arxiv.org/pdf/2602.20309) · [awesome-efficient-vla](https://github.com/guanweifan/awesome-efficient-vla)
- 数据门槛：[采集机器人数据(遥操)指南](https://www.roboticscenter.ai/learn/collect-robot-training-data) · [LoRA 微调 VLA 2512.11921](https://arxiv.org/html/2512.11921v1)
- 对比表：[SVRC VLA Models Comparison](https://www.roboticscenter.ai/tools/vla-models-comparison)

> 注：部分 arXiv 编号（2602.x/2603.x/2606.x）为 2026 年新近预印本，工程化/权重成熟度低，已在表中标注"研究阶段"，引用时以已落地的 LeRobot/openpi/SmolVLA/GR00T 为准。
