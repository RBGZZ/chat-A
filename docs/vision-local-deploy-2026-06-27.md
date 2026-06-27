# 本地视觉模型部署调研

**日期**: 2026-06-27 | **目的**: 为 chat-A 感知层选择可本地部署的小型视觉模型

---

## 一、如果只能选一个：Moondream 1.8B

```
ollama pull moondream    # 1.7GB, Apache 2.0, 纯CPU 16GB流畅运行
```

| 维度 | 评价 |
|------|------|
| 部署 | 一条命令，Ollama 原生支持 |
| 硬件 | CPU 16GB 流畅 / GPU 6GB 完全加速 |
| 场景描述 | ★★★★ 细节超越部分 7B 模型 |
| 反幻觉 | POPE 86.9-91.3 |
| 提示词工程 | 支持结构化 JSON/XML 输出，同级最强 |
| 许可证 | Apache 2.0 商用无忧 |
| 不足 | 英文 only（可加翻译层），OCR ~78%（可搭配其他模型补强） |

---

## 二、Ollama 视觉模型对比表

| 模型 | pull 命令 | 下载大小 | 最小 RAM | CPU 体验 | 场景描述 | 适合 |
|------|----------|----------|----------|----------|----------|------|
| **Moondream 1.8B** | `ollama pull moondream` | 1.7 GB | 4 GB | ✅ 流畅 | ★★★★ | **首选**：日常场景描述 |
| SmolVLM2-500M | 需手动 GGUF | 1.2 GB | 1.5 GB | ✅ 很快 | ★★ | 边缘设备，基础 VQA |
| SmolVLM2-2.2B | 需手动 GGUF | 4.9 GB | 5 GB | ✅ 快 | ★★★ | 速度快但输出泛化 |
| **Granite3.2-Vision** | `ollama pull granite3.2-vision` | 2.4 GB | 4-6 GB | ✅ | ★★★★ | 文档/表格/OCR |
| Gemma3:4b | `ollama pull gemma3:4b` | 3.3 GB | 6 GB | ✅ | ★★★ | 快速简洁短标题 |
| **Qwen2.5-VL:3b** | `ollama pull qwen2.5-vl:3b` | 3.2 GB | 6 GB | ✅ | ★★★★ | OCR 强，计数有随机性 |
| LLaVA-Phi3 3.8B | `ollama pull llava-phi3` | 4.0 GB | 4-8 GB | ✅ | ★★★ | 推理强但 4096 ctx |
| LLaVA:7b | `ollama pull llava:7b` | 4.7 GB | 8 GB | ⚠️ 勉强 | ★★★ | 通用场景，v1.6 提升 OCR |
| **Qwen2.5-VL:7b** | `ollama pull qwen2.5-vl:7b` | 6.0 GB | 8-10 GB | ⚠️ 慢 | ★★★★★ | **精度最高**，幻觉 0.33% |
| MiniCPM-V:8b | `ollama pull minicpm-v:8b` | 5.5 GB | 16 GB | ❌ 极慢 | ★★★★★ | 中文/OCR 专用 |
| Llama3.2-Vision:11b | `ollama pull llama3.2-vision` | 7.8 GB | 12 GB | ❌ 太慢 | ★★★★ | 128K ctx，强推 GPU |
| LLaVA:13b | `ollama pull llava:13b` | 8.0 GB | 10 GB | ❌ 太慢 | ★★★★ | RAM 极限 |

> ⚠️ Phi-3.5-Vision (4.2B) — llama.cpp 不支持其架构，GGUF 转换崩溃，**完全不可用**。

---

## 三、非 Ollama 轻量模型（快速通道）

| 模型 | 参数 | 大小 | CPU 延迟 | 能力 | 许可 |
|------|------|------|----------|------|------|
| **YOLO26n** | 2.4M | ~12 MB ONNX | **~39 ms** | 检测/分割/姿态 | AGPL-3.0 |
| **CLIP ViT-B/32** | 151M | 89-352 MB ONNX | **~13-30 ms** | 零样本分类/嵌入 | MIT |
| MobileCLIP2-S0 | 53.8M | ~285 MB ONNX | **~3 ms** (iPhone) | 图像-文本嵌入 | Apple 研究协议 |
| Depth Anything V2 S | 24.8M | 18-97 MB ONNX | ~3 ms (GPU) | 单目深度 | Apache 2.0 |
| Florence-2 base | 0.23B | 230-920 MB ONNX | 1-10s | 标题/检测/OCR/分割 | **MIT** |
| SmolVLM-256M ONNX | 256M | 3 个 ONNX 文件 | ~345ms | VQA/标题 | Apache 2.0 |
| Moondream 0.5B ONNX | 500M | 422-593 MB | 快（CPU 优先设计） | 标题/VQA/检测 | Apache 2.0 |

---

## 四、Open VLM Leaderboard（<4B 参数）

| 排名 | 模型 | 参数 | 平均分 |
|------|------|------|--------|
| 1 | BlueLM-V-3B | 3.0B | 66.1 |
| 2 | Ovis2-2B | 2.46B | 65.2 |
| 3 | **Qwen2.5-VL-3B** | 3.75B | 64.5 |
| 4 | SAIL-VL-2B | 2.1B | 61.0 |
| 5 | InternVL2.5-2B | 2.0B | 60.9 |

---

## 五、硬件匹配

### 纯 CPU 16GB

| 可运行 | 推荐度 |
|--------|--------|
| **Moondream 1.8B** | ⭐⭐⭐⭐⭐ 首选 |
| Granite3.2-Vision 2B | ⭐⭐⭐⭐ 文档场景 |
| Qwen2.5-VL 3B | ⭐⭐⭐⭐ OCR 场景 |
| LLaVA-Phi3 3.8B | ⭐⭐⭐ |
| LLaVA:7b | ⚠️ 勉强 ~5-6 tok/s |
| Qwen2.5-VL:7b | ⚠️ 勉强 ~4-6 tok/s |
| Llama3.2-Vision 11B | ❌ 不可用 |
| MiniCPM-V 8B | ❌ 极慢 ~1-3 tok/s |

### GPU 6GB

| 模型 | VRAM | 性能 |
|------|------|------|
| Moondream 1.8B | ~2 GB | 极快 |
| Gemma 4 E2B | ~4-6 GB | 68.5 tok/s, 0.26s TTFT |
| LLaVA 7B (Q4) | ~5 GB | ~40-60 tok/s |
| Qwen2.5-VL 7B (Q4) | ~5-6 GB | ~40-50 tok/s |

### GPU 8GB

| 模型 | VRAM | 性能 |
|------|------|------|
| Qwen3-VL 8B (Q4) | ~7-8 GB | ~40-60 tok/s |
| Llama3.2-Vision 11B (Q4) | ~7.9 GB | ~40-50 tok/s |
| Gemma 3 12B (Q4) | ~7-8 GB | ~50-60 tok/s |

---

## 六、推荐双通道方案

```
摄像头/屏幕截图
  │
  ├─→ 快速通道（每帧/每隔几帧）
  │     YOLO26n (12MB, ~39ms CPU) → 物体标签 + 场景变化检测
  │     或 CLIP ViT-B/32 (89MB, ~13ms) → 场景粗标签
  │
  └─→ 慢速通道（按需触发）
        Moondream 1.8B (ollama, 1.7GB) → 自然语言场景描述
        或 Qwen2.5-VL 7B (ollama, 6GB, GPU) → 高质量描述

       触发条件：新物体出现 / 场景显著变化 / 用户主动询问
```

**快速通道决定"是否要叫醒慢速通道"；慢速通道产生可注入对话的语义描述。**

---

## 七、chat-A 推荐部署组合

### 纯 CPU 16GB（推荐起步配置）

```
ollama pull moondream                  # 视觉：场景描述
ollama pull granite3.2-vision          # 视觉：文档/文本（可选）
npm install sherpa-onnx-node           # 音频：CED-tiny 6MB
npm install onnxruntime-node           # 音频：emotion2vec 50MB
```

### GPU 8GB（推荐进阶配置）

```
ollama pull qwen2.5-vl:7b              # 视觉：高质量场景描述
npm install sherpa-onnx-node           # 音频：CED-tiny 6MB
npm install onnxruntime-node           # 音频：emotion2vec 50MB
```

---

## 八、参考

- Moondream: https://github.com/UnderController/moondream / https://ollama.com/library/moondream
- SmolVLM2: https://huggingface.co/blog/smolvlm2
- Qwen2.5-VL: https://ollama.com/library/qwen2.5-vl
- YOLO26: https://docs.ultralytics.com/models/yolo11/
- Florence-2: https://huggingface.co/microsoft/Florence-2-base
- Open VLM Leaderboard: https://huggingface.co/spaces/opencompass/open_vlm_leaderboard
