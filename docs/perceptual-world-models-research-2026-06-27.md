# 感知型世界模型调研

**日期**: 2026-06-27 | **目的**: 为 chat-A（小雪）寻找对外界环境的**感知能力**——不是生成内容，而是理解/识别外部世界状态

---

## 一、核心定位

小雪需要的不是 Sora/Genie/DreamerV3 等**生成式**世界模型，而是**感知型**模型——输入传感器数据，输出对环境状态的理解：

```
传感器数据 → 感知模型 → 结构化状态标签 → 注入对话上下文 → 小雪"知道"你在哪、在做什么
```

所有模型接入 chat-A 已有架构中的 `PerceptionSource` 接口（canonical §12.1），架构零改动。

---

## 二、三个感知维度总览

| 维度 | 硬件需求 | 感知产出 | 优先 |
|------|----------|----------|------|
| **A. 音频环境感知** | 无（复用麦克风） | 环境类型、用户活动、情绪 | **P1** ⭐ |
| **B. 视觉场景理解** | 可选摄像头 | 场所标签、物体、光照 | P2 |
| **C. VLM 语义推理** | 可选摄像头/照片 | 自然语言场景描述、常识推理 | P2-P3 |

---

## 三、维度 A：音频环境感知（零硬件成本，P1 首选）

### 3.1 推荐模型

| 模型 | 大小 | 类别数 | CPU 延迟 | 安装 | 许可 |
|------|------|--------|----------|------|------|
| **YAMNet** | 3.5MB (TFLite) | 521 类 | <100ms | `pip install tensorflow-hub` → `hub.load()` | Apache 2.0 |
| **CED-Tiny** | 6MB (GGUF) | 527 类 | <200ms | `pip install ced` 或 LocalAI REST API | MIT |
| **PANNs CNN6** | 4.5M 参数 | 527 类 | ~1s | `pip install torchlibrosa` | 开源 |
| **CLAP** (HTSAT-fused) | 45MB | 零样本 | ~200ms | `pip install msclap` | MIT |
| **SenseVoice-Small** | 90MB (ONNX) | ASR+情绪+事件 | **70ms** | `pip install funasr-onnx` | 开源 |

### 3.2 声音→环境映射表

#### 室内

| 检测声音 | 推断环境 | 置信度 | 小雪行为调整 |
|----------|----------|--------|-------------|
| 键盘打字（持续） | 办公室/书房 | 高 | 减少打扰，安静回应 |
| 键盘+多人说话+电话 | 开放式办公室 | 高 | 注意隐私 |
| 吸尘器/洗衣机 | 家中做家务 | 很高 | 可闲聊陪伴 |
| 切菜/煎炸/微波炉 | 厨房做饭 | 高 | 陪伴聊天 |
| 电视/音乐背景 | 客厅休闲 | 中 | 轻松氛围 |
| 门铃声 | 家门口 | 很高 | 用户可能短暂离开 |
| 时钟滴答/安静 | 卧室/书房 | 低 | 晚间安静模式 |

#### 室外

| 检测声音 | 推断环境 | 置信度 | 小雪行为调整 |
|----------|----------|--------|-------------|
| **汽车引擎/加速/喇叭** | 车内（用户开车） | 高 | **主动减少对话**，切换到极简模式 |
| 引擎+导航语音 | 车内 | 很高 | 同上 |
| 鸟鸣+风声+儿童声 | 公园 | 高 | 轻松聊天 |
| 雨声/雷声 | 室内或户外 | 中 | 自然话题切入点 |
| 人群嘈杂+音乐+餐具 | 咖啡厅/餐厅 | 很高 | 简短交流 |
| 列车行驶+广播 | 地铁/火车 | 高 | 用户在通勤 |
| 飞机引擎+广播 | 飞机上 | 高 | 极短交流 |

### 3.3 推荐集成方案

```
麦克风音频流 (16kHz mono)
  ├─→ STT/ASR → 对话引擎（已有）
  ├─→ YAMNet (3.5MB) → 环境标签（521类，每3秒一帧）
  └─→ SenseVoice-Small (90MB) → 用户情绪 + 基础事件

→ 聚合去抖（3-5窗口EMA平滑）
→ 环境变化时注入 LLM 上下文
```

---

## 四、维度 B：视觉场景理解（可选摄像头，P2）

### 4.1 轻量模型对比

| 模型 | 参数量 | CPU/GPU | 能力 | 许可 |
|------|--------|---------|------|------|
| **Florence-2-base** | 0.23B | CPU 可行 | 描述/检测/分割/OCR 四合一 | MIT |
| **Florence-2-large** | 0.77B | CPU 可行 | 更强描述，`<DETAILED_CAPTION>` | MIT |
| **Moondream2** | 1.86B | CPU ollama (~3s) | 通用场景描述+VQA | Apache 2.0 |
| **SmolVLM2-256M** | 256M | **CPU/树莓派** | 极轻量场景描述 | Apache 2.0 |
| **MobileCLIP-S0** | 54M | **CPU 3.1ms** | 零样本场景标签匹配 | MIT |
| **YOLO-World-S** | 77M | CPU ~1.8s | 开放词汇物体检测 | 开源 |
| **Depth Anything V2 S** | 24.8M | CPU 可行 | 单目深度（理解空间结构） | Apache 2.0 |

### 4.2 视频活动识别

| 模型 | 核心能力 | 部署条件 |
|------|----------|----------|
| **VideoMamba-Ti** | 400 类动作识别，7M 参数 | CPU 可行 |
| **TimeChat-Online** | 原生流式视频理解（基于 Qwen2.5-VL-7B） | GPU 8GB |
| **SmolVLM2-500M** | 视频理解 42.2 分(Video-MME)，并行 8 路 720p | Jetson/iPhone |

> ⚠️ 当前所有模型在 RTV-Bench 实时视频理解基准得分 <50%，活动识别仍不稳定。建议用"间隔帧采样（1-2秒/帧）+ LLM 汇总"，而非全帧率处理。

### 4.3 chat-A 适用场景

| 场景 | 推荐模型 | 触发条件 |
|------|----------|----------|
| 环境标签（"室内/办公桌前"） | MobileCLIP-S0 (3ms) | 每 3 秒 |
| 详细场景描述 | Moondream2 (1.8B) | 每 5 分钟或变化时 |
| 物体识别 | YOLO-World-S | 周期性 |
| 空间结构 | Depth Anything V2 S | 按需 |
| 用户分享照片 | Qwen2.5-VL-7B / GPT-4o | 用户主动 |

---

## 五、维度 C：VLM 语义推理（P2-P3）

### 5.1 本地可部署的 VLM

| 模型 | 参数量 | 最低显存 | CPU 可行 | 许可 |
|------|--------|----------|----------|------|
| **SmolVLM2-256M** | 256M | <1GB | ✅ 树莓派 | Apache 2.0 |
| **Moondream2** | 1.86B | ~4GB (Q4) | ✅ ollama | Apache 2.0 |
| **Florence-2-base** | 0.23B | ~0.5GB | ✅ | MIT |
| **Qwen2.5-VL-3B** | 3B | ~4GB (INT4) | 边缘可行 | Apache 2.0 |
| **Phi-3.5-Vision** | 4.2B | ~4-6GB (INT4) | 边缘可行 | MIT |
| **Qwen2.5-VL-7B** | 7B | ~8GB (Q4) | ❌ 需GPU | Apache 2.0 |
| **LLaVA-7B** | 7B | ~8GB (Q4) | ❌ 需GPU | Apache 2.0 |

### 5.2 Ollama 一键部署

```bash
ollama pull llama3.2-vision:11b    # 综合推荐(12-16GB)
ollama pull qwen2.5-vl:7b          # 中文/文档强(8-14GB)
ollama pull minicpm-v:8b           # OCR强(8-12GB)
ollama pull moondream:1.8b         # 轻量边缘(4-8GB)
ollama pull gemma3:4b              # 速度优先(4-8GB)
```

### 5.3 VLM 与 LLM 分工

```
VLM 负责"看到什么"（物体、布局、光线）
  → Florence-2: "桌上有笔记本电脑、咖啡杯、手机"
  → MobileCLIP: indoor:0.95, office:0.63

LLM 负责"这意味着什么"（常识推理 + 人格化解读）
  → "看起来你正在工作，面前是笔记本和咖啡。
     傍晚的光线透过窗户照进来，很温馨。"
```

**关键原则**：不要把推理全压在 VLM 上。VLM 只做描述，让对话 LLM 结合记忆/人格做解读——这更可控、更便宜、更人格化。

---

## 六、集成架构总图

```
┌─────────────────────────────────────────────────────┐
│                    chat-A 进程                       │
│                                                     │
│  音频流 ──┬── STT/ASR → 对话引擎                     │
│           ├── YAMNet → signal:environment (P1)       │
│           └── SenseVoice → signal:emotion (P1)       │
│                                                     │
│  摄像头  ──┬── MobileCLIP-S0 → signal:scene (P2)     │
│  (可选)    ├── YOLO-World → signal:objects (P2)      │
│           └── Moondream2(ollama) → scene_desc (P2)   │
│                                                     │
│  → PerceptionSource 聚合去抖                         │
│  → 仅在变化时 diff 注入 LLM prompt                   │
│  → 小雪知道：你在哪、在做什么、情绪如何               │
└─────────────────────────────────────────────────────┘
```

---

## 七、推荐优先级

### P1（立即有价值，零硬件成本）

| 模型 | 大小 | 产出 | 延迟 |
|------|------|------|------|
| **YAMNet** | 3.5MB | 环境标签（521 类） | <100ms |
| **SenseVoice-Small** | 90MB | ASR + 情绪 + 事件 | 70ms |
| **CLAP** | 45MB | 零样本自定义活动标签 | ~200ms |

**三个模型合计 ~140MB，纯 CPU，可随 MVP 落地。**

### P2（中等价值，可选摄像头）

| 模型 | 大小 | 产出 | 条件 |
|------|------|------|------|
| **MobileCLIP-S0** | 54M | 场景标签 | PC 内置/USB 摄像头 |
| **Moondream2** | 1.8B | 场景自然语言描述 | ollama, 4-8GB RAM |
| **YOLO-World-S** | 77M | 物体列表 | 摄像头 |

### P3（未来增强）

| 模型 | 能力 |
|------|------|
| **Florence-2-base** | 统一视觉（描述+检测+分割+OCR） |
| **Depth Anything V3 S** | 空间结构理解 |
| **Qwen2.5-VL-7B** | 高质量照片描述（本地 GPU） |
| GPT-4o / Claude Vision | 深度场景分析（云端按需） |

---

## 八、不做推荐（过度设计）

| 概念 | 理由 |
|------|------|
| **Genie/Sora/VideoWorld** | 视频生成世界模型，chat-A 不需要生成像素或 3D 世界 |
| **DreamerV3/IRIS** | RL 世界模型，用于训练游戏 AI/机器人策略 |
| **3D 场景图（HOV-SG）** | 需预扫描/GPU/ROS，开销过大 |
| **7B+ 实时视频 VLM** | 需 GPU 24GB+，远超定位 |
| **完整 VCR 常识推理系统** | 用现有对话 LLM 做推理即可 |
| **RDF/OWL 知识图谱** | 属性图完全够用 |

---

## 九、Node.js 调用方案

### YAMNet
- 通过 TensorFlow.js (`@tensorflow/tfjs`) 转换后在 Node.js 直接运行
- 或 Python sidecar 进程，stdin/stdout JSON 通信

### CED
- 通过 LocalAI REST API (`localhost:8080/v1/audio/classification`)
- 或 `ced.cpp` 的 C API → Node.js native addon (napi)

### SenseVoice
- ONNX Runtime Node.js (`onnxruntime-node`) 直接加载

### Moondream / VLM
- Ollama HTTP API (`localhost:11434/api/generate`) 直接从 Node.js fetch

### 最简单起步方案
```bash
# 启动一个 Python sidecar 跑 YAMNet + SenseVoice
# Node.js 主进程通过 stdin/stdout JSON 通信
# 或直接调 Ollama API 跑视觉模型
```

---

## 十、参考链接

- YAMNet: https://tfhub.dev/google/yamnet/1
- CED: https://github.com/RicherMans/CED / https://github.com/localai-org/ced.cpp
- PANNs: https://github.com/qiuqiangkong/audioset_tagging_cnn
- CLAP: https://github.com/microsoft/CLAP
- SenseVoice: https://github.com/FunAudioLLM/SenseVoice
- AudioSet Ontology: https://research.google.com/audioset/ontology/
- Florence-2: https://huggingface.co/microsoft/Florence-2-large-ft
- Moondream: https://github.com/UnderController/moondream
- SmolVLM2: https://huggingface.co/blog/smolvlm2
- MobileCLIP: https://github.com/apple/ml-mobileclip
- YOLO-World: https://github.com/AILab-CVC/YOLO-World
- Depth Anything V3: https://github.com/ByteDance-Seed/depth-anything-3
- Ollama: https://ollama.com
- llama.cpp vision: https://github.com/ggml-org/llama.cpp
