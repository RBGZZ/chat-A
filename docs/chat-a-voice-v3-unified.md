# chat-A 语音管线 v3：双路径统一架构

> 多模态优先，传统兜底。模型适配层保留，同一网关管理两条路径。

---

## 一、核心思路：Qwen-Omni 是网关里的一个 Provider

```
不把 Omni 当特殊通道，而是当 LLM网关的一个 Provider——只是它多了一个能力标记。

┌─────────────────────────────────────────┐
│              LLM 网关 (保留)              │
│                                          │
│  ┌──────────┐  ┌──────────┐  ┌────────┐ │
│  │ Qwen-Omni│  │ DeepSeek │  │ Ollama │ │
│  │ audioIn  │  │ textOnly │  │ textOnly│ │
│  │ ✅       │  │          │  │ 本地   │ │
│  └────┬─────┘  └────┬─────┘  └───┬────┘ │
│       │              │            │      │
│       └──────────────┴────────────┘      │
│                      │                    │
│              路由决策: 有音频+Omni可用?    │
│               ├─ 是 → 多模态路径          │
│               └─ 否 → 传统路径(STT→LLM)   │
└──────────────────────────────────────────┘
```

## 二、Provider 能力标记

```javascript
const PROVIDERS = {
  'qwen-omni': {
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-omni-turbo'],
    capabilities: {
      supportsAudioInput: true,   // ← 多模态能力
      supportsVision: true,
      supportsTools: true,
    },
    tier: 'heavy',               // 首token延迟高，算heavy
  },
  'deepseek': {
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    capabilities: {
      supportsAudioInput: false,  // ← 纯文本
      supportsTools: true,
    },
    tier: 'standard',
  },
  'ollama': {
    protocol: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    models: ['qwen3:8b'],
    capabilities: {
      supportsAudioInput: false,
      supportsTools: false,       // prompt-mode MCP
    },
    tier: 'cheap',
  },
}
```

## 三、两条路径，一个出口

```
                    ┌─────────────┐
                    │   VAD检测    │ ← 永远在跑
                    │ (Silero本地) │
                    └──────┬──────┘
                           │
                    检测到完整语音段
                           │
                    ┌──────┴──────┐
                    │  路由决策    │
                    │              │
                    │ Omni可用?    │
                    └──┬──────┬───┘
                       │      │
                  YES  │      │  NO
                       ▼      ▼
              ┌──────────┐  ┌──────────┐
              │ 路径A     │  │ 路径B     │
              │ 多模态    │  │ 传统      │
              └────┬─────┘  └────┬─────┘
                   │              │
              audio→Omni    STT→LLM(text)
                   │              │
                   └──────┬───────┘
                          │
                    都是文本流输出
                          │
                    ┌─────┴─────┐
                    │ 流式分类器  │ ← 完全不变
                    └─────┬─────┘
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           显示文本    口语文本     情绪标签
           (UI气泡)   (→TTS)     (→人格引擎)
                          │
                    ┌─────┴─────┐
                    │ 自定义TTS  │ ← 完全不变
                    │ AudioQueue │
                    │ Player     │
                    └───────────┘
```

## 四、路由决策逻辑

```javascript
class LLMGateway {
  async processUtterance(audioBuffer, { signal, preferMultimodal = true }) {
    // 1. 检查多模态Provider是否可用
    const omni = this.providers.get('qwen-omni')
    const canUseMultimodal = preferMultimodal 
      && omni 
      && !omni.inCooldown          // 没在冷却期
      && omni.hasCredentials()

    if (canUseMultimodal) {
      try {
        return await this.multimodalPath(audioBuffer, { signal })
      } catch (err) {
        if (err.isRetryable) {
          omni.enterCooldown()      // 标记冷却，下次走传统路径
          // 自动降级到传统路径
          return await this.textPath(audioBuffer, { signal })
        }
        throw err
      }
    }

    // 2. 传统路径
    return await this.textPath(audioBuffer, { signal })
  }

  async multimodalPath(audioBuffer, { signal }) {
    // 音频直送 Qwen-Omni
    const stream = await this.fetchStream('qwen-omni', {
      messages: [{
        role: 'user',
        content: [
          { type: 'audio', audio: toBase64(audioBuffer) },
          { type: 'text',  text: '（请从语气中感知用户情绪）' }
        ]
      }],
      stream: true,
    }, { signal })

    return this.wrapStream(stream)  // 包装为统一 AsyncIterator<delta>
  }

  async textPath(audioBuffer, { signal }) {
    // 先STT
    const text = await this.stt.transcribe(audioBuffer, { signal })
    
    // 再LLM (可能走DeepSeek/Ollama failover链)
    const stream = await this.fetchStreamWithFailover(text, { signal })
    
    return this.wrapStream(stream)
  }
}
```

## 五、两个路径的情绪感知能力差异

```
路径A (多模态):
  情绪来源: 模型从原始音频感知
  准确度: 高 (听到真实语调)
  延迟: 较高 (音频处理3-5秒)
  
  Omni输出: "你今天听起来有点低落呢。[user_emotion:sad-6]"

路径B (传统):
  情绪来源: 模型只能从文字猜测
  准确度: 中 (可能误判)
  延迟: 低 (文本LLM首token快)
  
  LLM输出:  "你怎么了？[user_emotion:neutral]"  ← 猜不到真实情绪

结论: 多模态在情绪感知上有质的优势，值得优先使用。
      传统路径保证在任何情况下系统都不崩溃。
```

## 六、故障切换链（完整的三级）

```
用户说话
  │
  ▼
尝试 Qwen-Omni 多模态
  ├─ 成功 → 情绪感知满分 ✅
  └─ 失败(429/超时/冷却中) →
       │
       ▼
     尝试 DeepSeek 文本 (先STT)
       ├─ 成功 → 基础对话 ✅
       └─ 失败 →
            │
            ▼
          尝试 Ollama 本地 (先STT)
            ├─ 成功 → 降级但可用 ⚠️
            └─ 失败 → 播一句"我遇到点问题..." 🔴
```

## 七、最终模块清单

```
保留 (11个):
  ✅ bus.js                LightVoiceBus
  ✅ processor.js          VoiceProcessorManager + generation计数
  ✅ vad.js                VAD + EchoGuard (Silero本地)
  ✅ stt.js                STT引擎 (传统降级路径需要)
  ✅ llm/
      gateway.js           LLM网关 (管理两条路径)
      providers/           Qwen-Omni / DeepSeek / Ollama
      failover.js          failover链 + 退避冷却
  ✅ classifier.js         流式分类器
  ✅ tts/
      engine.js            自定义TTS引擎
      providers/           多TTS Provider
  ✅ player.js             AudioPlayer即时停止
  ✅ queue.js              AudioQueue反压
  ✅ personality/          人格引擎
  ✅ memory/               记忆引擎
  ✅ character/            角色管理

不删！只是增强:
  🆕 llm/gateway.js 增加 multimodalPath + textPath 双路径路由
  🆕 personality/ 增加音频情绪接收通道
```

## 八、与传统方案的本质区别

```
不是一个新管线替代旧管线。
是一个网关管理两条路径，多模态优先，传统永远兜底。

就像一辆混动车:
  电机(多模态)优先工作 → 高效安静
  没电了 → 发动机(传统)无缝接管 → 保证到达
```
