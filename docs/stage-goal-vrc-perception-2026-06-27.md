# 阶段性目标：VRChat 接入 + 世界模型感知层

**日期**: 2026-06-27 | **状态**: 架构定稿，待实现

---

## 目标概述

系统通过 OSC + 虚拟音频接入 VRChat，同时用本地小型开源模型构建感知层，让小雪感知用户在 VRChat 中的环境和状态。

```
感知层（本地小模型）          集成层（VRChat）              Agent 核心
─────────────────────        ──────────────────           ──────────
音频环境 → CED-tiny    →                             →   小雪知道：
语音情绪 → emotion2vec →    OSC /chatbox ← 文字显示        "你在 VRChat
                          OSC /avatar ← 表情驱动          的咖啡馆世界，
视觉场景 → Moondream →    VB-Cable    ← TTS 语音          和朋友在一起，
                          VB-Cable    → VRChat 音频       听起来挺热闹"
VRChat API → 好友/世界                                     → 对话上下文
```

---

## 三层架构

### 第 1 层：VRChat 原生数据（无需模型，OSC/API 直接提供）

| 数据源 | 接口 | 感知产出 |
|--------|------|----------|
| 用户语音能量 | OSC `/avatar/parameters/Voice` (float 0-1) | 用户是否在说话 |
| 用户口型 | OSC `/avatar/parameters/Viseme` (int 0-14) | 用户说话的口型（可推断说话强度） |
| 用户手势 | OSC `/avatar/parameters/GestureLeft/Right` (int) | 用户手势状态 |
| Avatar 切换 | OSC `/avatar/change` (string) | 用户换了新 Avatar |
| 当前世界 | VRChat API `/instances/{worldId}` | 世界名、描述、容量 |
| 好友在线 | WebSocket Pipeline `friend-online/location` | 谁在线、在哪 |

### 第 2 层：音频感知（本地小模型，复用麦克风）

| 模型 | 大小 | 感知产出 | 延迟 |
|------|------|----------|------|
| **CED-tiny** | 6MB (ONNX/GGUF) | 527 类环境音 → 用户在什么环境 | ~117ms |
| **emotion2vec+ 蒸馏** | ~50MB (ONNX) | 8 类语音情感 → 用户情绪 | ~50ms |

### 第 3 层：视觉感知（可选，本地小 VLM）

| 模型 | 大小 | 触发条件 | 感知产出 |
|------|------|----------|----------|
| **Moondream2** | 1.8B (ollama Q4) | 用户分享照片或屏幕捕获 | 场景自然语言描述 |
| **MobileCLIP-S0** | 54M (ONNX) | 周期性（间隔帧） | 场景标签 |

---

## 数据流

```
VRChat 客户端
  │
  ├─ OSC :9000 → chat-A
  │   ├─ /avatar/parameters/Voice → 用户是否在说话
  │   ├─ /avatar/parameters/Viseme → 口型信息
  │   └─ /avatar/change → Avatar 切换事件
  │
  ├─ VRChat API (REST + WS) → chat-A
  │   ├─ 好友在线/位置
  │   └─ 当前世界信息
  │
  └─ 音频流
      ├─ → VRChat 麦克风输入（网络发送给其他玩家）
      ├─ → chat-A STT → 对话引擎（已有管线）
      ├─ → CED-tiny (6MB) → 环境标签
      └─ → emotion2vec (50MB) → 用户情绪
```

---

## 实现阶段

### 阶段 1：VRChat 原生感知 + 虚拟音频打通（P2）
- [ ] `packages/vrchat-bridge/` 包骨架
- [ ] OSC 收发（`osc` npm 包，端口 9000/9001）
- [ ] VRChat API 封装（`vrchat-api-library`）
- [ ] 虚拟音频双线（VB-Cable：TTS 注入 + VRChat 音频捕获）
- [ ] Chatbox 文字发送 + Avatar 参数控制
- [ ] VRChat 事件 → PerceptionSource 适配

### 阶段 2：音频感知层（P2）
- [ ] CED-tiny 集成（sherpa-onnx-node，6MB，环境音分类）
- [ ] emotion2vec 集成（onnxruntime-node，50MB，语音情感）
- [ ] 感知结果 → PerceptionSource → 去抖 → LLM prompt 注入
- [ ] 环境感知 → 小雪行为策略（开车时免打扰、办公室安静模式等）

### 阶段 3：视觉感知（P3）
- [ ] 可选摄像头/屏幕捕获支持
- [ ] Moondream2 部署（ollama，1.8B Q4）
- [ ] MobileCLIP-S0 快速通路（3ms 场景标签）
- [ ] 视觉感知 → 对话上下文注入

### 阶段 4：深度感知（P4）
- [ ] 视觉记忆累积（用户环境时间线）
- [ ] 社会感知：VRChat 中谁在附近、社交气氛
- [ ] 配套 VRChat Avatar 参数约定文档 + Unity Package
