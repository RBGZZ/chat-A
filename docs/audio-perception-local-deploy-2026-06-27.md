# 本地音频感知模型部署调研

**日期**: 2026-06-27 | **目的**: 为 chat-A 感知层选择可本地部署的小型音频模型

---

## 一、最小推荐栈：方案 A（56MB 覆盖环境+活动+情绪）

| 模型 | 大小 | 功能 | 部署 | CPU延迟 |
|------|------|------|------|---------|
| **CED-tiny** | 6 MB (GGUF q8) | 527 类 AudioSet 环境音/声音事件 | `sherpa-onnx-node` | ~117ms |
| **emotion2vec+ 蒸馏** | ~50 MB (ONNX INT8) | 8 类语音情感 | `onnxruntime-node` | ~50ms |
| **合计** | **~56 MB** | 环境+活动+情绪全覆盖 | 纯 Node.js，零 Python | ~170ms |

BERT 大小的模型（110M 参数），在 Node.js 进程中直接跑，无需 Docker/LocalAI/Python sidecar。

---

## 二、声学场景分类模型

### CED-tiny（首选）

| 属性 | 值 |
|------|-----|
| 参数量 | 5.5M |
| 大小 | 6 MB (GGUF q8_0) |
| 类别 | AudioSet 527 类 |
| CPU 延迟 | ~117ms / 10s 音频 |
| 部署 | `npm install sherpa-onnx-node` |
| 许可 | MIT |
| 可行性 | 🟢 一行 npm install |

**527 类覆盖清单（部分）**:

| 类别 | AudioSet ID | 用途 |
|------|------------|------|
| Typing | 397 | 用户在打字 → 办公室 |
| Computer keyboard | 156 | 同上 |
| Vehicle | 444 | 用户在开车/坐车 |
| Engine | 194 | 同上 |
| Frying (food) | 211 | 用户在做饭 |
| Microwave oven | 284 | 同上 |
| Doorbell | 176 | 门铃 → 用户会短暂离开 |
| Rain | 320 | 下雨 → 自然话题 |
| Thunderstorm | 383 | 同上 |
| Coffee | 145 | 咖啡机 → 咖啡厅 |
| Background music | 46 | 公共场所/休闲 |
| Laughter | 266 | 用户在笑 |
| Baby cry | 27 | 用户照看婴儿 |
| Dog bark | 175 | 用户在遛狗 |
| Silence | 349 | 安静环境 |
| Speech | 364 | 有人在说话 |

**CED 模型家族**:

| 型号 | 参数量 | q8_0 大小 | AudioSet mAP |
|------|--------|-----------|-------------|
| ced-tiny | 5.5M | **6 MB** | 48.1 |
| ced-mini | 9.6M | 11 MB | 49.0 |
| ced-small | 22M | 23 MB | 49.6 |
| ced-base | 86M | 88 MB | 50.0 |

推荐从 tiny 起步（6MB 够用），按需升级到 mini/small。

### YAMNet（备选）

| 属性 | 值 |
|------|-----|
| 大小 | 4 MB (TFLite INT8) |
| 类别 | AudioSet 521 类 |
| 部署 | TensorFlow.js 或 TFLite |
| 可行性 | 🟡 需 TF 运行时或额外转换 |

CED-tiny 已完全覆盖 YAMNet 的功能且更易部署，YAMNet 仅作为备选方案记录。

---

## 三、语音情绪识别模型

### emotion2vec+ base（推荐）

| 属性 | 值 |
|------|-----|
| 参数量 | ~90M (base) |
| 大小 | <50 MB (知识蒸馏 ONNX INT8) |
| 情感类别 | 8 类: angry, disgusted, fearful, happy, neutral, sad, surprised, unknown |
| CPU 延迟 | <100ms |
| 部署 | `pip install funasr`（用于导出 ONNX），运行时用 `onnxruntime-node` |
| 可行性 | 🟢 ONNX Runtime Node.js 直接加载 |

### SenseVoice-Small（备选——一体化但更大）

| 属性 | 值 |
|------|-----|
| 大小 | 230 MB (INT8 ONNX) |
| 功能 | ASR (50+语言) + 情感 + 音频事件，一模型三用 |
| CPU 延迟 | 70ms / 10s 音频 |
| 部署 | `pip install funasr-onnx` → Python sidecar |
| 可行性 | 🟢 但需 Python sidecar |

**对比**: SenseVoice 230MB 功能强但不适合嵌入 Node.js 进程。如果 chat-A 需要独立的 ASR 模块复用 SenseVoice 可以一举三得，否则用 emotion2vec (50MB) + CED (6MB) 更轻量。

---

## 四、Ollama 音频支持现状

**结论：Ollama 不支持音频模型。**

- Ollama 专注 LLM，无原生音频 API
- 社区有 whisper.cpp 包装但非正式功能
- **替代方案**:
  - **sherpa-onnx-node**: Node.js 原生绑定，跑 CED/ASR/TTS
  - **onnxruntime-node**: 通用 ONNX 推理
  - **LocalAI**: 覆盖 OpenAI 兼容 API + 音频模型，但需 Docker

---

## 五、安装指南（方案 A）

```bash
# 1. 安装 npm 包
npm install sherpa-onnx-node onnxruntime-node

# 2. 下载 CED-tiny ONNX 模型（约 6MB）
# sherpa-onnx 提供预转换好的模型
curl -SL -o ced-tiny.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-ced-mini-audio-tagging-2024-04-19.tar.bz2
tar xf ced-tiny.tar.bz2

# 3. 导出 emotion2vec ONNX（一次性）
pip install funasr modelscope
python scripts/export_emotion2vec_onnx.py  # 需自写导出脚本

# 或者直接用 Python sidecar 跑 emotion2vec（无需导出）
```

**Node.js 调用示例（sherpa-onnx-node）**:
```typescript
import { AudioTagging } from 'sherpa-onnx-node';

const tagger = new AudioTagging({
  model: './sherpa-onnx-ced-mini-audio-tagging-2024-04-19/model.int8.onnx',
  labels: './sherpa-onnx-ced-mini-audio-tagging-2024-04-19/class_labels_indices.csv',
});

// 每 3 秒滑动窗口
const results = tagger.tag(audioSamples); // sampleRate 必须与模型匹配
// → [{tag: "Typing", prob: 0.87}, {tag: "Speech", prob: 0.65}, ...]
```

---

## 六、集成到 chat-A

### 架构

```
麦克风音频流 (16kHz mono, PCM s16le)
  │
  ├─→ [已有] STT Pipeline → 对话引擎
  │
  ├─→ CED-tiny (sherpa-onnx-node, 6MB)
  │     ├─ 每 3 秒滑动窗口
  │     ├─ 3-5 窗口 EMA 平滑去抖
  │     └─ → signal:environment { type, confidence, timestamp }
  │
  └─→ emotion2vec (onnxruntime-node, 50MB)
        ├─ 每句语音结束触发（跟随 TurnDetector）
        └─ → signal:emotion { valence, arousal, label, confidence }
```

### 去抖策略

```
连续 3 个窗口检测到 "咖啡馆" 且置信度 > 0.5 → 确认环境为 cafe
单窗口噪声 → 忽略
环境切换 → 需连续 3 个新窗口确认 → 触发 diff 注入
```

### LLM prompt 注入格式

只在环境/情绪**变化时**注入，不每轮重复：

```
[environment: cafe, crowded]
[user_emotion: happy, energetic]
```

---

## 七、参考

- CED: https://github.com/RicherMans/CED
- ced.cpp: https://github.com/localai-org/ced.cpp
- sherpa-onnx: https://github.com/k2-fsa/sherpa-onnx
- emotion2vec: https://github.com/ddlBoJack/emotion2vec
- SenseVoice: https://github.com/FunAudioLLM/SenseVoice
- AudioSet: https://research.google.com/audioset/
