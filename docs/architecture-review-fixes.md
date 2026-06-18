# chat-A 架构审查修复方案

---

## 1. 启动/关闭生命周期

**借鉴**: voice-core 的 `start()/stop()` + Nexus 的 Provider 健康检查

```
系统启动流程:
  1. 加载配置 (config.yaml / .env)
  2. 检查 Provider 连接 (每个 Provider 发一个最小请求验证连通)
     ├─ 全通 → 正常启动
     ├─ 部分通 → 降级启动 (标记不可用的进冷却)
     └─ 全不通 → 报错退出
  3. 恢复持久化状态 (人格档案、记忆索引、上次对话)
  4. 初始化 VoiceBus + ProcessorManager
  5. 启动 VAD 监听
  6. 触发 session:start → 系统就绪

系统关闭流程:
  1. 收到 SIGTERM/SIGINT
  2. 停止 VAD 监听
  3. 取消所有进行中的 Processor
  4. 清空 AudioQueue
  5. 持久化当前状态 (人格快照、记忆变更)
  6. 关闭 Provider 连接
  7. 退出
```

"健康检查借鉴 Nexus connectionPreflight.ts：发一个最小请求验证 API Key 和 URL 是否可用。"

---

## 2. 配置管理

**借鉴**: LingYa 的 `agent_config.yaml` + eros_ai 的 pydantic-settings

```yaml
# config/default.yaml
character:
  name: "小雪"
  relationship: "朋友"

personality:
  ocean:
    openness: 0.6
    conscientiousness: 0.5
    extraversion: 0.7
    agreeableness: 0.8
    neuroticism: 0.3
  core_belief: "陪伴是最长情的告白"
  guardrails:
    - "不对用户进行道德评判"
    - "不主动提供未经请求的建议"

voice:
  vad:
    silence_timeout_ms: 1500
    sensitivity: 0.5
  wake_word: "小雪"
  wake_enabled: true

providers:
  multimodal:
    - id: qwen-omni
      base_url: https://dashscope.aliyuncs.com/compatible-mode/v1
      api_key: ${QWEN_API_KEY}
      priority: 1
  text:
    - id: deepseek
      base_url: https://api.deepseek.com
      api_key: ${DEEPSEEK_API_KEY}
      priority: 2
    - id: ollama
      base_url: http://localhost:11434/v1
      priority: 3
  tts:
    - id: cosyvoice
      base_url: http://localhost:9880
      voice_id: "xiaoxue_v2"

storage:
  type: sqlite
  path: ./data/chat-a.db

limits:
  max_cost_per_day_usd: 2.0
  max_cost_per_session_usd: 0.5
```

"环境变量引用 `${QWEN_API_KEY}` 从 .env 文件注入，代码中只读 config 对象。"

---

## 3. 可观测性

**借鉴**: Nexus metering + VoiceBus history

```javascript
// 三层日志
class Logger {
  // 结构化日志 (持久化到 SQLite)
  event(type, data) { /* { type:'session:start', time, provider, ... } */ }
  
  // 性能指标
  metric(name, value, tags) { /* tts_latency_ms: 230, provider: cosyvoice */ }
  
  // 错误追踪
  error(source, err) { /* 带堆栈 + 上下文快照 */ }
}

// VoiceBus 自动记录
bus.onAny((type, data) => logger.event(type, data))

// 健康检查端点 (可选)
GET /health → { status: 'ok', uptime, active_provider, last_error }
```

---

## 4. 唤醒机制

**借鉴**: Nexus wakewordRuntime (唤醒词 + 永远监听 两种模式)

```
模式A: 唤醒词模式 (默认)
  VAD 始终运行 → 检测到唤醒词 → 进入 LISTENING
  → 后续对话无需唤醒词 (直到回到 IDLE 60秒)
  
  实现: Silero VAD + porcupine/picovoice 唤醒词检测
  唤醒词: 可配置 (默认 "小雪")

模式B: 永远监听模式 (可选)
  VAD 始终运行 → 任何语音都触发 LISTENING
  → 适合私密环境

模式C: 手动触发 (fallback)
  点击/快捷键 → 进入 LISTENING
```

---

## 5. 路由决策逻辑

```
统一规则: VAD 永远在跑。任何时候检测到新语音 → 立即中断当前操作。

路径选择 (每句话开始时):
  sortedProviders = providers.filter(p => !p.inCooldown)
                            .sort((a,b) => a.priority - b.priority)
  
  for provider of sortedProviders:
    if provider.supportsAudioInput:
      尝试多模态路径 → 成功 ✅ → 返回
      失败 → provider.enterCooldown() → continue
    else:
      audio → STT → text → 尝试 provider → 成功 ✅ → 返回
      失败 → provider.enterCooldown() → continue

降级策略:
  多模态5秒无首token → 视为失败 → 立即降级
  (不等完整超时，5秒阈值避免用户等太久)
  
  传统路径3秒无首token → 降级到下一个Provider
```

---

## 6. PROCESSING 状态的打断

**借鉴**: voice-core 的关键模式——不检查状态，直接中断

```
voice-core 的做法:
  listener线程永远在跑
  检测到语音 → _interrupt_current_operation()
    不论当前是 PROCESSING 还是 SPEAKING 还是 IDLE
    直接 cancel token → clear queue → allocate generation

chat-A 应该用同样策略:
  不区分 PROCESSING/SPEAKING
  VAD检测到任何语音 → processor.allocate() → 中断一切

区别只在中断后的行为:
  PROCESSING时被中断 → 丢弃LLM请求 (没损失)
  SPEAKING时被中断 → 停止TTS + 清空队列 (用户听到了部分)
  
  对外表现一样: 瞬间安静 + 开始听用户说话
```

---

## 7. 传统路径情绪补丁

```
问题: STT→LLM 路径丢失了音频情绪

方案: 在 STT 之后、LLM 之前，加一个轻量情绪预检测

路径B增强:
  audio → STT → text
       ↘ 轻量情感分析 (本地) → emotion_vector {valence, arousal}
           → 注入 system prompt: "用户当前情绪: 略微低落"

实现选择 (按复杂度):
  A. 正则关键词: "烦死了" → frustration  (零成本，但不准)
  B. 本地小模型:  sentiment-analysis  (几十MB，较准)
  C. 用同一段音频调 Omni 的情绪API (精准但增加成本)

建议: 先用B (本地小模型)，后续可平滑升级到C
```

---

## 8. 冷启动人格

**借鉴**: LingYa `MindState.from_config()`

```
第一次启动时:
  ocean = config.personality.ocean  ← 从YAML读取的初始值
  pad_baseline = ocean_to_pad(ocean)  ← 派生PAD基线
  beliefs = [config.personality.core_belief]
  ipc = { agency: 0.5, communion: 0.5 }  ← 中性

系统提示中的表现:
  "你叫小雪，是一个温柔的朋友。你刚刚认识眼前的这个人，还不太了解TA。
   保持友善和好奇，自然地了解TA。"

前10-20次对话:
  - 情绪波动幅度比后续小 (冷启动系数 0.5)
  - 记忆权重偏高 (初期的信息更重要)
  - delta演化更敏感 (快速建立初步画像)

20次对话后:
  - 切换为标准模式
  - 情绪/记忆/演化的参数恢复正常
```

---

## 9. 存储后端

```
选择: SQLite (单文件、零配置、Node.js 有 better-sqlite3)

理由:
  - 独立机器部署 → 不需要客户端-服务器数据库
  - 配置文件 + 记忆 + 人格档案 + 日志 → 一个文件全搞定
  - better-sqlite3 同步API，不引入异步复杂度

表结构:
  memories        (id, type, content, importance, last_access, embedding BLOB)
  personality     (id, ocean_json, beliefs_json, ipc_json, version, updated_at)
  sessions        (id, started_at, ended_at, transcript_json, emotion_summary)
  events          (id, type, data_json, created_at)
  config          (key, value)
  provider_state  (provider_id, cooldown_until, error_count, last_success)

向量检索:
  初期: 不引入向量数据库，用简单的文本匹配 + 情感共振
  P3+: 需要时再引入 (sqlite-vss 扩展 或 LanceDB)
```

---

## 10. 人格演化触发时机

**借鉴**: eros_ai 每次会话后 + LingYa 累计重要性阈值

```
方案: 混合触发

触发条件 (满足任一):
  A. 累计对话轮次 >= 20 (大约30分钟对话)
  B. 情绪显著变化 (PAD向量偏移 > 0.3)
  C. 用户主动触发 (/reflect 命令)

频率限制:
  - 两次演化间隔 >= 2小时
  - 每天最多 3 次

实现:
  turn_counter++
  accumulated_importance += turn_importance
  
  if (turn_counter >= 20 || pad_shift > 0.3) && canEvolve():
    await personality.evolve(session_transcript)
    turn_counter = 0
    accumulated_importance = 0
```

---

## 11. AudioQueue 优先级上调

```
原方案: P4 才加 AudioQueue 反压
修正: P1 就加基础版

P1交付:
  class SimpleAudioQueue {
    constructor(maxDepth = 5)  // 初期用5，够用
    put(chunk)  // 阻塞版
    get()       // 阻塞版
    clear()     // 打断用
  }

P4交付:
  升级到完整版 (动态maxDepth、超时、metrics)
```

---

## 12. 成本控制

**借鉴**: Nexus metering + 每日上限

```javascript
class CostTracker {
  dailyBudget = config.limits.max_cost_per_day_usd  // 默认 $2/天
  sessionBudget = config.limits.max_cost_per_session_usd  // 默认 $0.5/会话
  
  // 每次LLM调用前检查
  async checkBeforeCall(provider, estimatedTokens) {
    const cost = this.estimateCost(provider, estimatedTokens)
    
    if (this.sessionCost + cost > this.sessionBudget) {
      // 会话预算用完 → 强制降级到本地Ollama
      return { allowed: false, fallback: 'ollama' }
    }
    
    if (this.todayCost + cost > this.dailyBudget) {
      // 每日预算用完 → 强制降级
      return { allowed: false, fallback: 'ollama' }
    }
    
    return { allowed: true }
  }
  
  // 无成本的本地模型不计入
  estimateCost(provider, tokens) {
    if (provider.tier === 'local') return 0
    return provider.pricing.input * tokens.input + 
           provider.pricing.output * tokens.output
  }
}
```
