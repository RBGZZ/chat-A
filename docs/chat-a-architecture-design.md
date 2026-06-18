# chat-A 系统设计方案

> 综合 Nexus / voice-core / eros_ai / LingYa 六个系统的源码研究结论
> 目标：实时语音对话陪伴Agent，独立机器部署，流式全链路

---

## 一、总体架构

```
┌─────────────────────────────────────────────────────────┐
│                    入口层                                │
│  CLI入口 / 桌面托盘 / 开机自启                            │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────────┐
│                  LightVoiceBus                           │
│   session:start | user:speech_end | ai:start_speaking   │
│   ai:stop_speaking | interrupted | error                │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬───────────┘
   │      │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼      ▼
┌──────┐┌─────┐┌────┐┌────┐┌──────┐┌──────┐┌──────────┐
│ STT  ││ VAD ││LLM ││TTS ││Player││人格  ││  记忆     │
│引擎  ││检测 ││引擎││引擎││引擎  ││引擎  ││  引擎     │
└──┬───┘└──┬──┘└─┬──┘└─┬──┘└──┬───┘└──┬───┘└────┬─────┘
   │       │     │     │      │       │         │
   └───────┴─────┴─────┴──────┴───────┴─────────┘
                       │
              ┌────────┴────────┐
              │  VoiceProcessor │
              │  Manager        │
              │  generation计数  │
              │  AbortController │
              │  5状态机         │
              └─────────────────┘
```

## 二、模块清单与来源

| 模块 | 职责 | 借鉴来源 | 关键文件 |
|------|------|---------|---------|
| **VoiceProcessorManager** | 打断安全、状态转移、资源清理 | voice-core | orchestrator.py |
| **LightVoiceBus** | 模块间松耦合通信 | Nexus(精简) | bus.ts |
| **STT引擎** | 语音→文本，多引擎 | Nexus + voice-core | localSenseVoice.ts |
| **VAD检测** | 语音活动检测+回声消除 | voice-core | browserVad.ts |
| **LLM网关** | 多Provider统一接入+故障切换 | Nexus | failoverChain.ts |
| **流式分类器** | delta→显示/语音/元数据分流 | Nexus | assistantReply.ts |
| **TTS引擎** | 文本→语音，流式合成 | Nexus | streamingSpeechOutput.ts |
| **AudioPlayer** | PCM播放+即时停止 | voice-core | orchestrator.py |
| **人格引擎** | OCEAN+delta演化+信念锚定 | LingYa+eros_ai | engine.py, personality_update.py |
| **记忆引擎** | 衰减共振+Hot/Cold+双Pass | Nexus+eros_ai | decay.ts, memory_curation.py |
| **角色管理** | 多角色档案+语音绑定切换 | Nexus | profiles.ts |

## 三、核心数据流

### 3.1 一次完整的语音对话

```
用户说话
  │
  ▼
VAD: 检测到语音 → EchoGuard检查(排除回声)
  │
  ▼
STT: 实时流式转写 → bus.emit('stt:partial', {text})
  │
  ▼ (静音1.5秒)
STT: 最终文本 → bus.emit('user:speech_end', {text: "今天天气真好"})
  │
  ▼
VoiceProcessor.allocate() → generation++, 取消旧processor
  │
  ▼
状态: PROCESSING
  │
  ├─► 记忆引擎: 搜索相关记忆 → 注入上下文
  ├─► 人格引擎: 当前OCEAN+情绪 → 调制系统提示
  └─► LLM网关: 构建请求 → 故障切换链 → 流式生成
        │
        ▼
      流式分类器:
        ├─► 显示delta → UI气泡
        ├─► 元数据[expr:happy] → 人格引擎
        └─► 口语delta → TTS引擎
              │
              ▼
            AudioQueue(反压, maxDepth=10)
              │
              ▼
            AudioPlayer: 播放
              │
              ▼
            状态: SPEAKING (VAD仍在监听)
              │
              ├─ 播放完毕 → bus.emit('ai:stop_speaking') → IDLE
              └─ 用户插话 → bus.emit('interrupted') → LISTENING
```

### 3.2 打断的精确时序

```
时刻T0: AI正在播放 "今天天气确实不错呢..."
  AudioQueue中有3个待播chunk

时刻T1: VAD检测到用户语音
  → bus.emit('interrupted', {by: 'user'})
  → VoiceProcessor.allocate()  ← generation从5→6
  → AudioPlayer.stop()         ← 立即静音(<50ms)
  → AudioQueue.clear()         ← 丢弃3个chunk
  → 状态: PROCESSING→LISTENING

时刻T2: 旧processor的回调触发
  → 检查 isCurrent(5) → false → 丢弃

时刻T3: 新processor开始处理用户新的语音
  → generation=6
```

## 四、LLM网关层设计

```javascript
// 借鉴 Nexus failoverChain.ts + providerCatalog.ts
class LLMGateway {
  providers = new Map()  // providerId → { protocol, baseUrl, models }
  
  async chat(messages, options) {
    // 1. 构建候选链
    const chain = this.buildChain(options.preferred)
    //    [DeepSeek, OpenAI, Ollama本地]

    // 2. 故障切换执行
    for (const candidate of chain) {
      try {
        const response = await this.callProvider(candidate, messages)
        // 3. 归一化为 ChatCompletionResponse
        return { content, tool_calls, finish_reason }
      } catch (err) {
        if (this.isRetryable(err)) {
          this.cooldown(candidate.id)  // 指数退避
          continue
        }
        throw err
      }
    }
  }
}
```

## 五、人格引擎设计

```javascript
// 借鉴 LingYa OCEAN + Belief + eros_ai delta演化
class PersonalityEngine {
  profile = {
    ocean: { O:0.6, C:0.5, E:0.7, A:0.8, N:0.3 },  // LingYa基础
    traits: { empathy:0.8, humor:0.6, ... },         // eros_ai 31特质
    beliefs: ['人是善良的', '世界值得探索'],          // LingYa信念
    ipc: { agency:0.4, communion:0.7 },              // LingYa关系姿态
    version: 0,
    history: []
  }

  // 实时：调制系统提示
  buildSystemPrompt() {
    return `
      你是${this.character.name}。
      当前情绪：${this.emotion}。
      关系阶段：${this.ipcToStage(this.profile.ipc)}。
      核心信念：${this.profile.beliefs.join('；')}
    `
  }

  // 异步：会话后演化 (借鉴eros_ai双Pass)
  async evolve(transcript) {
    // Pass1: LLM分析 → 观察/缺失/新候选
    const signals = await this.analyze(transcript)
    // Pass2: 计算delta → 应用 (加/减幅度小，保证稳定性)
    const deltas = this.computeDeltas(signals)
    this.applyDeltas(deltas)
    this.profile.version++
    this.profile.history.push({ version, deltas, time })
  }
}
```

## 六、记忆引擎设计

```javascript
// 借鉴 Nexus衰减共振 + eros_ai Hot/Cold + 双Pass
class MemoryEngine {
  // Hot记忆：永远在prompt (借鉴eros_ai)
  hot = { name, age, gender, language, relationship }

  // Cold记忆：按需检索 (借鉴Nexus)
  async recall(context) {
    return this.hybridSearch({
      semantic: await this.vectorSearch(context),     // 语义
      emotional: this.emotionResonance(context.vad),   // 情感共振
    })
  }

  // 记忆衰减 (借鉴Nexus)
  decay(memory) {
    const days = (Date.now() - memory.lastAccess) / 86400000
    memory.importance *= Math.exp(-0.05 * days)
  }

  // 会话后调和 (借鉴eros_ai双Pass)
  async curate(transcript) {
    const candidates = await this.extract(transcript)   // Pass1
    const existing = await this.getAll()
    const diff = await this.reconcile(candidates, existing) // Pass2
    // { add: [...], update: [...], delete: [...], discard: [...] }
    await this.applyDiff(diff)
  }
}
```

## 七、流式分类器设计

```javascript
// 借鉴 Nexus 3层过滤管道
class StreamClassifier {
  filters = [
    new ToolCallFilter(),        // 剥离工具调用
    new ExpressionTagFilter(),   // 剥离 [expr:happy] 等
  ]

  // 语音通道额外一层
  speechFilter = new StageDirectionFilter() // 剥离舞台指示

  push(delta) {
    // 层层过滤
    let text = delta
    for (const f of this.filters) text = f.push(text)

    return {
      display: text,                        // → UI气泡
      speech: this.speechFilter.push(text), // → TTS
      metadata: this.extractTags(delta),    // → 人格/动作引擎
    }
  }
}
```

## 八、目录结构

```
chat-A/
├── src/
│   ├── core/
│   │   ├── bus.js              # LightVoiceBus
│   │   ├── processor.js        # VoiceProcessorManager
│   │   └── state.js            # 5状态 reducer
│   ├── voice/
│   │   ├── vad.js              # VAD + EchoGuard
│   │   ├── stt.js              # STT引擎 + 多引擎
│   │   ├── player.js           # AudioPlayer (即时停止)
│   │   └── queue.js            # AudioQueue (反压)
│   ├── llm/
│   │   ├── gateway.js          # LLM网关 + failover链
│   │   ├── providers/          # 各Provider适配
│   │   └── classifier.js       # 流式分类器
│   ├── tts/
│   │   ├── engine.js           # TTS引擎
│   │   └── providers/          # 各TTS Provider
│   ├── personality/
│   │   ├── engine.js           # 人格引擎 (OCEAN+delta)
│   │   ├── profile.js          # 人格档案
│   │   └── evolution.js        # 双Pass演化
│   ├── memory/
│   │   ├── store.js            # 记忆存储
│   │   ├── recall.js           # 混合召回
│   │   ├── decay.js            # 衰减
│   │   └── curation.js         # 双Pass调和
│   └── character/
│       └── profiles.js         # 多角色管理
├── docs/                       # 所有研究文档
└── config/
    └── default.js
```

## 九、开发顺序

| 阶段 | 内容 | 依赖 |
|------|------|------|
| **P0** | LightVoiceBus + VoiceProcessorManager + 5状态机 | 无 |
| **P0** | AudioQueue + AudioPlayer(即时停止) | P0 |
| **P1** | VAD + STT (最简实现先跑通) | P0 |
| **P1** | LLM网关(单Provider) + 流式分类器 | P0 |
| **P1** | TTS引擎(单Provider) | P0 |
| **P2** | 人格引擎(基础OCEAN, 无演化) | P0 |
| **P2** | 记忆引擎(基础存储+检索, 无衰减) | P0 |
| **P3** | LLM网关 failover链 + 多Provider | P1 |
| **P3** | 人格 delta演化 | P2 |
| **P3** | 记忆 衰减+双Pass调和 | P2 |
| **P4** | 角色管理 + 语音绑定 | P2 |
| **P4** | AudioQueue反压 | P0 |
