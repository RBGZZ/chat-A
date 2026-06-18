# 多系统全面对比：实时对话陪伴 Agent 参考架构

> 基于对 **Nexus / eros_ai / LingYa / voice-core / realtime-voice-agent-demo / claude-code-haha** 六个开源项目的源码阅读。

---

## 一、各系统概览

| 维度 | Nexus | eros_ai | LingYa | voice-core | realtime-voice-agent | claude-code-haha |
|------|-------|---------|--------|------------|---------------------|-----------------|
| **语言** | TypeScript | Python | Python | Python | Python + Node | TypeScript(Bun) |
| **定位** | 桌面宠物伴侣 | 情感陪伴Agent | 人格演化Agent | 语音基础设施 | 语音对话Demo | 终端Agent |
| **UI** | Electron + Live2D | FastAPI后端 | 终端/API | 无UI(库) | Next.js Web | Ink终端 |
| **LLM接入** | 30+ Provider | Gemini | 可注入 | Ollama | Ollama/Kimi/Claude | Anthropic |
| **对话方式** | 文本+语音全双工 | 文本 | 文本 | 语音全双工 | 语音全双工 | 文本 |
| **Stars** | 14⭐ | 1⭐ | 0⭐ | 1⭐ | 2⭐ | — |
| **代码规模** | ~1265文件 | ~20文件 | ~20文件 | ~15文件 | ~30文件 | ~100文件 |

---

## 二、人格系统对比

### 核心差异一张表

```
                Nexus           eros_ai            LingYa
人格模型:     PetMood状态机    31维Jungian特质     OCEAN五因素
情绪模型:     PAD三维连续       情绪权重标量        OCC→PAD连续
人格演化:     固定+共同调节     双Pass LLM增量      OCEAN drift缓慢漂移
关系建模:     共同调节          implicit            IPC双轴状态机
信念系统:     无                无                  信念锚定+概率更新
语气调制:     TTS voice切换     无                  tone矩阵动态计算
```

### 详细分析

**Nexus — PetMood 离散状态机**

```
模型: PAD(VAD) 三维向量 → 7种离散 PetMood
优势: 简单直接，和 Live2D 表情槽位一一映射
局限: 无法表达"70% 开心 + 30% 焦虑"的混合状态
      人格固定，只有共同调节(coregulation)没有演化
源码: autonomy/emotionModel.ts, autonomy/coregulation.ts
```

**eros_ai — 31维 Jungian 演化人格**

```
模型: 31个连续特质 [0,1] → 双Pass LLM演化
Pass1: LLM分析会话 → 观察到的/缺失的/新候选特质
Pass2: 计算delta权重 → 应用到profile
特色: 版本快照可回溯，ARQ后台异步不阻塞对话
局限: 无情绪实时模型，只有会话级后分析
源码: pipelines/personality_update.py, app/models/personality.py

31特质 = 8 Jungian轴 + 5情绪 + 5认知 + 5人际 + 5行为 + 3动机
```

**LingYa — OCEAN + Belief + IPC 三层人格**

```
Layer 1 — OCEAN五大因素: 开放性/尽责性/外向性/宜人性/神经质
  → ocean_drift() 缓慢漂移
  → ocean_to_pad_baseline() 转化为PAD情绪基线

Layer 2 — Belief信念系统:
  → OCEAN调制信念更新概率 (高宜人性→易改变)
  → LLM双门决策: LLM判断 + 概率阈值
  → reanchor守卫: 漂移过远时LLM生成修正提示

Layer 3 — IPC关系双轴: Agency × Communion
  → 5种关系状态机 (专业防御/温暖倾听/危机干预/游戏协作)
  → LLM few-shot从最近对话估计
  → 合法转移图约束
源码: mind/engine.py, mind/belief.py, mind/dynamics.py
```

---

## 三、记忆系统对比

| 维度 | Nexus | eros_ai | LingYa |
|------|-------|---------|--------|
| **记忆分类** | 短期/每日/长期/叙事/冷存储 | Hot/Cold 双轨 | 统一存储 |
| **衰减模型** | 指数衰减 e^(-λt) | 分类过期(daily:7天) | 基于重要性 |
| **召回方式** | 语义+情感共振 双路 | 文本搜索 | 嵌入式向量 |
| **记忆生成** | 每日自主生成 | 双Pass LLM调和 | LLM摘要 |
| **独有特性** | 情感共振检索、叙事记忆、Open Arc | 双Pass add/update/delete/discard、自动分类 | rule_based_importance |

### 详细分析

**Nexus — 最完整的记忆管线**

```
流程: 对话 → 每日记忆 → 衰减计算 → 长期存储 → 冷归档
检索: 语义向量 + 情感VAD共振 → 混合排名
特色: 叙事记忆(编织故事线)、On This Day(周年回忆)、Open Arc(叙事弧线)
源码: memory/decay.ts, memory/emotionResonance.ts, memory/recall.ts
```

**eros_ai — 最系统化的记忆管理**

```
流程: 会话结束 → Pass1: LLM提取候选 → Pass2: LLM对比已有 → diff{add,update,delete,discard}
特色: Hot/Cold自动分类、7天daily_context过期、零规则全LLM驱动
源码: pipelines/memory_curation.py

Hot记忆: name, age, gender, location, language → 永远在prompt
Cold记忆: events, preferences, goals, opinions → 按需检索
```

---

## 四、流式架构对比

| 维度 | voice-core | realtime-voice-agent | claude-code-haha | Nexus |
|------|-----------|---------------------|-----------------|-------|
| **并发模型** | threading | asyncio | AsyncGenerator | Electron IPC + Bus |
| **打断机制** | CancellationToken | asyncio.cancel | AbortController | Bus事件+AbortSetter |
| **STT** | Whisper+SileroVAD | Whisper/Deepgram | 无(文本) | SenseVoice/Paraformer/Tencent |
| **TTS** | Piper | Piper/Edge TTS | 无(文本) | 多Provider流式TTS |
| **分句策略** | SentenceSplitter | _take_sentence | 无 | sentenceBoundaryDetector |
| **音频传输** | AudioQueue(线程) | WebSocket binary PCM | 无 | Electron IPC PCM |

### 打断机制三种范式

**voice-core — CancellationToken (最通用)**

```python
class CancellationToken:
    def cancel(self): self._cancelled = True
    def is_cancelled(self): return self._cancelled

# 每处关键路径检查
for chunk in stream:
    if token.is_cancelled(): return
```

**realtime-voice-agent — asyncio.create_task + cancel (最Pythonic)**

```python
response_task = asyncio.create_task(_respond(...))
# 新输入到达
response_task.cancel()
response_task = asyncio.create_task(_respond(...))  # 新任务
```

**Nexus — Bus事件 + AbortSetter (最解耦)**

```typescript
busEmit({ type: 'session:aborted', reason: 'barge_in' })
// 各组件通过Bus监听，自行清理
abort()  // LLM流终止
player.stopAndClear()  // 音频停止
```

---

## 五、模型接入与统一输出对比

| 维度 | Nexus | realtime-voice-agent | claude-code-haha |
|------|-------|---------------------|-----------------|
| **Provider数** | 30+ | 3 (Ollama/Kimi/Claude) | 1 (Anthropic) |
| **抽象方式** | ProviderPreset目录 + protocol标签 | Adapter抽象类 + 工厂 | 单一SDK |
| **故障切换** | 候选链 + 指数退避冷却 | 无 | fallback非流式 |
| **协议归一化** | Electron主进程转换 | Adapter内部转换 | 原生SDK |
| **能力检测** | 纯正则(零延迟) | 无 | 无 |

---

## 六、独特功能横向对比

| 功能 | 哪个系统有 | 价值 |
|------|----------|------|
| **演化人格** | eros_ai (31特质)、LingYa (OCEAN) | 陪伴系统核心差异化 |
| **信念锚定** | LingYa | 人格一致性保障 |
| **关系姿态机** | LingYa (IPC双轴) | 对话风格动态切换 |
| **Hot/Cold记忆** | eros_ai | 记忆系统必修 |
| **双Pass记忆调和** | eros_ai | 记忆精准度保障 |
| **情感共振检索** | Nexus | 记忆召回的新维度 |
| **叙事记忆** | Nexus | 长期陪伴的故事线 |
| **Voice Filler** | eros_ai | 填补等待空白 |
| **全双工语音** | Nexus, voice-core | 实时对话刚需 |
| **13状态语音机** | Nexus | 最完整语音状态管理 |
| **流式输出分类** | Nexus (21章) | 文本/语音/元数据分流 |
| **Agent多步循环** | Nexus | 自主任务执行 |
| **CancellationToken** | voice-core | 通用打断原语 |
| **Provider工厂** | realtime-voice-agent | 多模型切换最简方案 |
| **AsyncGenerator流** | claude-code-haha | 服务端流式最佳实践 |

---

## 七、对你项目的最佳组合建议

```
chat-A 推荐架构 = 核心来自 Nexus + 增强来自 eros_ai/LingYa

┌─────────────────────────────────────────┐
│              人格系统                     │
│  LingYa OCEAN 基础 + eros_ai 演化delta   │
│  + LingYa Belief 信念锚定                │
├─────────────────────────────────────────┤
│              记忆系统                     │
│  Nexus 衰减+共振检索 + eros_ai Hot/Cold  │
│  + eros_ai 双Pass LLM调和               │
├─────────────────────────────────────────┤
│              流式架构                     │
│  Nexus 流式分类管道 + voice-core Cancel  │
│  + realtime-voice-agent Provider工厂     │
├─────────────────────────────────────────┤
│              语音系统                     │
│  Nexus 13状态机 + voice-core AudioQueue  │
│  + eros_ai Voice Filler                 │
├─────────────────────────────────────────┤
│              模型接入                     │
│  Nexus failover链 + Provider协议标签     │
│  + LingYa llm_call可注入模式            │
└─────────────────────────────────────────┘
```

### 优先级建议

| 优先级 | 来自 | 做什么 | 理由 |
|--------|------|--------|------|
| P0 | Nexus | 流式输出分类 + 13状态语音机 | 你的第一需求 |
| P0 | voice-core | CancellationToken打断 | 通用、轻量、可直接复用 |
| P1 | eros_ai | Hot/Cold记忆 + 双Pass调和 | 你强调的记忆系统 |
| P1 | LingYa | OCEAN人格 + Belief | 超越Nexus的人格深度 |
| P2 | realtime-voice-agent | Provider工厂模式 | 你的网关层多平台 |
| P2 | eros_ai | Voice Filler | 语音体验打磨 |
