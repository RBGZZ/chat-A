# chat-A 系统设计方案（最终版 v2.1）

> 综合六个开源项目研究 + 架构审查修复
> 定位：实时语音对话陪伴Agent | 部署：独立机器(Node.js) | 核心：流式全链路

---

## 一、技术决策总览

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 运行时 | Node.js | 对比Bun后选定 |
| 存储 | SQLite (better-sqlite3) | 单文件零配置，独立机器最优 |
| 配置 | YAML + .env注入 | LingYa风格，可读可版本控制 |
| 语音打断 | CancellationToken + generation计数 | voice-core模式，六个方案中最稳健 |
| 语音状态 | 简化5状态 + 无条件中断 | 不论状态，VAD检测到语音直接中断 |
| 唤醒 | 唤醒词(默认) / 永远监听 / 手动触发 | 三种模式可配置 |
| 模块通信 | 轻量VoiceBus(6事件) | 取Nexus精华，去45事件复杂度 |
| 多模态 | 能力驱动：优先 supportsAudioInput Provider | 不绑定具体模型，换模型只改配置 |
| 传统管线 | STT+LLM 兜底 + 情感补丁 | 保证任何情况下不崩溃 |
| TTS | 自定义音色复刻 | 刚需，不妥协 |
| 人格 | LingYa OCEAN + eros_ai delta演化 + 冷启动 | 从YAML种子开始，前20轮加速学习 |
| 记忆 | Nexus衰减共振 + eros_ai Hot/Cold双Pass | 最完整方案 |
| 模型接入 | 网关统一管理，能力标记路由 | 不删适配层 |
| 可观测性 | 三层日志(event/metric/error) → SQLite | 生产可调试 |
| 成本控制 | 日预算$2 + 会话预算$0.5 → 超限降级 | 防止API费用失控 |

---

## 二、系统启动/关闭

```
启动流程 (6步):
  1. 加载 config/default.yaml + .env
  2. Provider 连接预检 → 标记不可用的进冷却
  3. 初始化 SQLite → 恢复人格/记忆/对话状态
  4. 初始化 VoiceBus → ProcessorManager → 5状态reducer
  5. 启动 VAD 监听 (Silero本地)
  6. bus.emit('session:start') → 系统就绪

关闭流程 (7步):
  1. 收到 SIGTERM/SIGINT
  2. bus.emit('session:stop')
  3. 停止 VAD 监听
  4. processor.abortAll() → 取消所有进行中的请求
  5. AudioQueue.clear() + Player.stop()
  6. 持久化当前状态 → SQLite
  7. 关闭 Provider 连接 → 退出
```

---

## 三、配置结构

```yaml
# config/default.yaml
character:
  name: "小雪"
  relationship: "朋友"

personality:
  ocean: { openness: 0.6, conscientiousness: 0.5, extraversion: 0.7, agreeableness: 0.8, neuroticism: 0.3 }
  core_belief: "陪伴是最长情的告白"
  guardrails:
    - "不对用户进行道德评判"
    - "不主动提供未经请求的建议"
  cold_start:
    enabled: true
    warmup_turns: 20       # 前20轮加速学习
    emotion_damping: 0.5   # 情绪波动减半

voice:
  vad: { silence_timeout_ms: 1500, sensitivity: 0.5 }
  wake: { word: "小雪", enabled: true, idle_timeout_s: 60 }

providers:
  multimodal:  # 按priority排序，数字越小越优先
    - { id: qwen-omni, priority: 1, audio_input: true,  pricing: { input: 1.5, output: 5.0 } }
  text:
    - { id: deepseek,   priority: 2, audio_input: false, pricing: { input: 0.27, output: 1.1 } }
    - { id: ollama,     priority: 3, audio_input: false, pricing: { input: 0, output: 0 } }
  tts:
    - { id: cosyvoice, base_url: "http://localhost:9880", voice_id: "xiaoxue_v2" }

storage:
  db_path: ./data/chat-a.db

limits:
  max_cost_per_day_usd: 2.0
  max_cost_per_session_usd: 0.5

logging:
  level: info
  retain_days: 30
```

---

## 四、总体架构

```
┌──────────────────────────────────────────────────────────┐
│                     LightVoiceBus                         │
│  6事件: session:start | user:speech_end |                 │
│         ai:start_speaking | ai:stop_speaking |           │
│         interrupted | error                               │
└──┬──────┬──────┬──────┬──────┬──────┬──────┬────────────┘
   │      │      │      │      │      │      │
   ▼      ▼      ▼      ▼      ▼      ▼      ▼
┌──────┐┌────┐┌────┐┌──────┐┌────┐┌──────┐┌──────┐┌───────────┐
│Wake  ││VAD ││STT ││LLM   ││TTS ││Player││人格  ││  记忆      │
│唤醒词││检测││引擎││网关  ││引擎││引擎  ││引擎  ││  引擎      │
└──┬───┘└──┬─┘└──┬─┘└──┬───┘└──┬─┘└──┬───┘└──┬───┘└─────┬─────┘
   │       │     │     │       │     │       │          │
   └───────┴─────┴─────┴───────┴─────┴───────┴──────────┘
   │      │     │       │     │       │          │
   └──────┴─────┴───────┴─────┴───────┴──────────┘
                      │
             ┌────────┴────────┐
             │ VoiceProcessor  │
             │ Manager         │
             │ generation计数   │
             │ 5状态reducer    │
             │ 无条件中断       │
             └────────┬───────┘
                      │
             ┌────────┴────────┐
             │    CostTracker  │
             │  日预算/会话预算  │
             │  超限→强制降级   │
             └────────┬───────┘
                      │
             ┌────────┴────────┐
             │     Logger      │
             │ event/metric/err│
             │    → SQLite     │
             └─────────────────┘
```

---

## 五、语音管线：能力驱动的双路径

```
                    VAD + 唤醒词 (永远在跑)
                         │
                  VAD检测到语音
                  → 无条件中断当前操作 ← 不区分PROCESSING/SPEAKING
                         │
                   检测到语音结束 (静音1.5s)
                         │
                   ┌─────┴──────┐
                   │  LLM网关    │
                   │             │
                   │ CostTracker │ ← 检查预算
                   │ .check()    │
                   └──┬──────┬───┘
                      │      │
         有audioIn Provider│无audioIn Provider
         且未超预算        │或已超预算
                      ▼      ▼
              ┌──────────┐ ┌──────────────┐
              │ 路径A     │ │ 路径B         │
              │ 多模态    │ │ 传统 + 补丁   │
              │ audio→    │ │ audio→STT→    │
              │ Provider  │ │ 情感分析→LLM  │
              │           │ │               │
              │5秒无token │ │3秒无token     │
              │→降级路径B │ │→下一个Provider│
              └─────┬─────┘ └──────┬────────┘
                    │              │
              都是文本流输出        │
                    └──────┬───────┘
                           │
                     ┌─────┴─────┐
                     │ 流式分类器  │
                     │ 3层过滤管道 │
                     └─────┬─────┘
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
           显示文本     口语文本     情绪标签
           (UI气泡)    (→TTS)     (→人格引擎)
                           │
                    自定义TTS音色
                     AudioQueue反压 (maxDepth=5)
                     AudioPlayer即时停止
```

---

## 六、打断安全：无条件中断

```
① VAD永远在跑，检测到语音 → 无条件中断当前操作
   不论PROCESSING还是SPEAKING → processor.allocate() → cancel一切

② processor_generation 单调递增计数器
   每次中断 → generation++
   所有异步回调先检查 isCurrent(id)
   → 旧processor的任何输出自动丢弃

③ AudioQueue 反压 (maxDepth=5 P1 → 升级到10 P4)
   约1-3秒预生成缓冲
   超限阻塞LLM生成 → 自然减速
   打断时 clear() → 全部丢弃

④ 每个异步操作配超时
   多模态首token: 5s → 降级 | 文本LLM首token: 3s → 降级
   TTS合成: 10s | 单句播放: 30s | 空闲: 60s → IDLE
```

---


---

## 五-B、UX 关键时刻设计

语音陪伴Agent的用户体验不是功能需求，而是**时间线上的情感节奏**。以下四个关键时刻决定了用户感知的"自然度"。

### 时刻1: 唤醒反馈 (< 300ms)

```
用户说"小雪" → VAD检测 → 系统响应:

视觉/听觉反馈:
  ├─ 提示音: 短促柔和的"叮"(不是刺耳的"嘀")
  ├─ 指示灯: 呼吸灯从暗变亮(表示"我在听")
  └─ 无语音回复(唤醒词不需要口头确认)

超时: 3秒内无后续语音 → 提示音变低 → 灯熄灭 → 回IDLE
误触发处理: 连续3次唤醒后无有效语音 → 进入5分钟冷却
```

### 时刻2: 思考中 (< 5秒)

```
用户说完话 → 系统处理中 (Omni首token通常3-5秒):

第0-2秒:
  ├─ 指示灯: 缓动呼吸(表示"正在想")
  └─ 无声音(避免打断用户的思绪延续)

第2-5秒:
  ├─ filler语音: "嗯..." / "让我想想..." (随机选一句)
  │   语调: 与当前人格匹配 (温柔型→"嗯...稍等一下哦")
  │   长度: 不超过2秒
  └─ 若5秒仍无响应 → 降级到传统路径 (用户不需要知道)

"思考中"与"被打断"的区别:
  思考中 → 灯在呼吸 + filler → 用户知道它在想
  被打断 → 灯立刻切换 + 旧输出中断 → 用户知道它在听新的
```

### 时刻3: 错误恢复

```
场景A: Provider故障 (Omni降级到DeepSeek)
  用户感知: 无变化 (静默降级)
  日志记录: logger.event('provider:degraded', { from, to, reason })
  仅当所有云端Provider都失败 → 播一句"信号不太好，我用本地脑力回答你哦"

场景B: 网络断开
  立即: 指示灯变橙色
  TTS播报: "网络好像断开了，我先把本地脑力打开" (只播一次)
  后续: 自动切到Ollama本地 → 指示灯恢复

场景C: 崩溃重启
  恢复后: 指示灯快闪2秒 → 播报"刚才不小心走神了..."
  对话上下文: 从SQLite恢复最后5轮对话
  记忆/人格: 从最后快照恢复 (最多丢失当前会话的未保存变更)
```

### 时刻4: 空闲行为 (IDLE状态)

```
IDLE进入: 对话结束60秒后无新输入

0-5分钟:
  指示灯: 微弱的呼吸灯 (表示"还在")
  行为: 不主动说话 (不打扰)

5-30分钟:
  不做任何事 (尊重用户的安静时间)

30分钟+:
  触发条件: 以下任一满足
    - 距离上次对话 >= 30分钟
    - 用户刚回到电脑前 (桌面活动检测)
    - 到了预设时间 (如晚上9点)
  主动问候: 简短、不强迫
    "回来啦~"
    "要不要休息一下眼睛？"
    (每天最多3次主动问候, 可配置)

夜间模式 (23:00-08:00):
  指示灯: 熄灭或极暗
  主动问候: 禁止
  唤醒词: 仍可用 (用户可以主动找它)
```

## 七、人格系统：OCEAN + 冷启动 + delta演化

```
冷启动 (前20轮):
  ocean = config.personality.ocean  ← YAML种子
  beliefs = [config.core_belief]
  emotion_damping = 0.5  ← 情绪波动减半，避免早期过拟合
  memory_weight_boost = 1.5  ← 初期信息权重更高

成熟期 (20轮后):
  emotion_damping = 1.0  ← 恢复正常
  delta演化启用 (双Pass LLM)

演化触发 (满足任一 + 不低于2小时间隔):
  累计轮次 >= 20
  PAD向量偏移 > 0.3
  每天最多3次

冷启动系统提示:
  "你叫小雪，是一个温柔的朋友。你刚刚认识眼前的这个人，还不太了解TA。
   保持友善和好奇，自然地了解TA。"
```

---

## 八、记忆系统：衰减共振 + Hot/Cold 双Pass

```
存储: SQLite, 表 memories (id, type, content, importance, embedding, last_access, ...)

分层:
  Hot记忆  → 姓名/年龄/关系 → 每次prompt注入
  Short记忆 → 最近20轮对话 → 完整保留
  Long记忆 → 衰减+重要性 → 按需检索
  Cold存储 → 低频访问 → 归档

检索 (混合召回):
  score = 语义相似度*0.4 + 情感共振*0.3 + 时间衰减*0.2 + 重要性*0.1

调和 (eros_ai双Pass):
  每20轮触发 → Pass1提取候选 → Pass2对比已有 → diff{add,update,delete,discard}
  daily_context → 7天自动过期

向量检索:
  P1-P2: 简单文本匹配 + 情感共振 (不引入向量DB)
  P3+: 需要时引入 sqlite-vss 或 LanceDB
```

---



### 人格 ↔ 记忆 交叉数据流

```
人格 ──影响──► 记忆:
  OCEAN.openness → 新记忆接纳阈值 (开放性高→更容易记录新事物)
  OCEAN.neuroticism → 负面记忆权重 (神经质高→负面事件记得更牢)
  当前情绪(PAD) → 情感共振检索的查询向量

记忆 ──影响──► 人格:
  检索到的记忆 → 注入system prompt → 影响当前回复语气
  长期记忆中的"自我认知" → Belief锚定检查的参照
  叙事记忆(故事线) → IPC关系姿态演化的输入
  周年回忆 → 触发情绪波动 (PAD临时偏移)

冷启动时的特殊关系:
  无记忆时 → 人格用YAML种子 → OCEAN主导行为
  积累20轮记忆后 → 记忆开始反向塑造人格 → delta演化启用
  长期运行 → 记忆和人格形成稳定反馈循环
```

---

## 九、流式输出：3层过滤管道

```
LLM原始delta
  │
  ▼ ① PromptModeFilter (工具调用剥离)
  │
  ▼ ② PerformanceTagFilter (表情/动作标签剥离 [expr:happy]等)
  │
  ▼ visibleDelta
  │
  ├─► 显示通道: → UI气泡 (保留舞台指示)
  │
  └─► ③ StageDirectionFilter (全角括号舞台指示剥离)
        │
        ▼ spokenDelta → TTS引擎 (纯口语)
```

---

## 十、模型适配层：能力驱动的多模态抽象

```
任何Provider统一接口:

class LLMProvider {
  get supportsAudio() { return this.capabilities.audioInput }
  get local() { return this.tier === 'local' }

  async *stream(input, { signal }) {
    const messages = input.audio && this.supportsAudio
      ? this.buildAudioMessages(input)
      : this.buildTextMessages(input)
    // ... 后续完全一致
  }
}

换模型只改配置:
  providers.multimodal[0].id: qwen-omni  →  gpt-4o  →  qwen-audio-local

路由决策:
  sorted = providers.filter(p => !p.inCooldown && costTracker.canUse(p))
                    .sort((a,b) => a.priority - b.priority)
  逐个尝试 → 优先 supportsAudio=true → 失败降级 → 最后到本地Ollama

故障切换:
  候选链 → 指数退避冷却(1min→5min→25min→60min) → 持久化到SQLite
```

---

## 十一、成本控制

```
CostTracker:
  日预算: $2.0  |  会话预算: $0.5
  本地Provider (Ollama): 不计入

每次LLM调用前:
  estimated = provider.pricing.input * estInputTokens
            + provider.pricing.output * estOutputTokens

  if sessionCost + estimated > sessionBudget → 强制降级到Ollama
  if todayCost + estimated > dailyBudget    → 强制降级到Ollama

定价表 (单位: $/1M tokens):
  qwen-omni:    input $1.5  output $5.0
  deepseek:     input $0.27 output $1.1
  ollama:       input $0    output $0   (本地不计费)
```

---

## 十二、可观测性

```
三层日志 → SQLite events 表:

  logger.event(type, data)   // 结构化事件
  logger.metric(name, value) // 性能指标
  logger.error(source, err)  // 错误追踪

VoiceBus 自动记录:
  bus.onAny((type, data) => logger.event(type, data))

保留策略:
  events 保留 30 天
  metrics 保留 90 天
  errors 永久保留

调试工具:
  bus.history → 最近100条事件
  GET /health → { status, uptime, activeProvider, sessionCost, todayCost }
```

---



---

## 十二-B、部署与运维

### systemd 服务配置 (Linux)

```ini
# /etc/systemd/system/chat-a.service
[Unit]
Description=chat-A Voice Companion Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=chat-a
WorkingDirectory=/opt/chat-a
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production

# 安全加固
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/opt/chat-a/data

[Install]
WantedBy=multi-user.target
```

### Windows Service (备用)

```powershell
# 使用 winsw 或 node-windows
# chat-a-service.xml
<service>
  <id>chat-a</id>
  <name>chat-A Voice Companion</name>
  <description>Real-time voice conversation companion agent</description>
  <executable>node</executable>
  <arguments>src/index.js</arguments>
  <workingdirectory>/opt/chat-a</workingdirectory>
  <onfailure action="restart" delay="10 sec"/>
</service>
```

### 日志轮转

```
SQLite events 表自动清理:
  events → 保留 30 天 (每日凌晨清理)
  metrics → 保留 90 天
  errors → 永久保留 (但超过1年的压缩归档)
  
清理策略:
  每日 03:00 执行 VACUUM + 删除过期记录
  单文件超过 500MB → 告警 + 手动检查

文本日志 (stdout → journald):
  journald 自动轮转: max 100MB, retain 7 days
```

### 健康检查 + 告警

```
GET /health → {
  status: "ok" | "degraded" | "down",
  uptime: 123456,
  active_provider: "qwen-omni",
  providers: {
    "qwen-omni": "ok",
    "deepseek": "ok", 
    "ollama": "ok"
  },
  session_cost_usd: 0.12,
  today_cost_usd: 0.45,
  last_error: null
}

告警条件 (日志中标记 ALERT):
  - 所有Provider不可用 > 5分钟
  - 连续10次LLM调用失败
  - SQLite 超过 500MB
  - 磁盘剩余 < 1GB
```

### 配置热加载

```
监听 config/default.yaml 变化 (fs.watch):
  → 非破坏性变更 → 即时生效 (如 log level, cost limits)
  → 破坏性变更 → 日志记录 + 下次重启生效 (如 provider 配置)
  → 不自动重启 (避免打断正在进行的对话)
```

---

## 十三、模块通信：轻量VoiceBus

```
6事件: session:start | user:speech_end | ai:start_speaking
       ai:stop_speaking | interrupted | error

3种订阅:
  on(type, fn) → unsubscribe()
  onAny(fn)    → 全局监听
  history      → 最近100条

handler被try/catch包裹 → 一个模块崩溃不影响其他
所有事件自动记录到 logger
```

---

## 十四、模块清单

```
chat-A/
├── config/
│   └── default.yaml              角色+人格+Provider+限额 配置
├── data/
│   └── chat-a.db                 SQLite (运行时自动创建)
├── src/
│   ├── core/
│   │   ├── bus.js                LightVoiceBus
│   │   ├── processor.js          VoiceProcessorManager + generation
│   │   ├── state.js              5状态reducer
│   │   ├── config.js             配置加载 (YAML + .env)
│   │   ├── logger.js             三层日志 → SQLite
│   │   └── cost.js               CostTracker
│   ├── voice/
│   │   ├── vad.js                VAD + EchoGuard
│   ├── wake.js               唤醒词检测 + 冷却 + 三种模式
│   │   ├── stt.js                STT引擎
│   ├── emotion.js            情感预检测 (传统路径补丁)
│   │   ├── player.js             AudioPlayer即时停止
│   │   └── queue.js              AudioQueue反压 (P1 maxDepth=5)
│   ├── llm/
│   │   ├── gateway.js            LLM网关 (双路径+路由+降级)
│   │   ├── providers/            Qwen-Omni / DeepSeek / Ollama
│   │   ├── failover.js           failover链 + 退避冷却 → SQLite
│   │   └── classifier.js         流式分类器(3层过滤)
│   ├── tts/
│   │   ├── engine.js             自定义TTS引擎
│   │   └── providers/            多TTS Provider
│   ├── personality/
│   │   ├── engine.js             OCEAN + 冷启动 + delta演化
│   │   ├── profile.js            人格档案 → SQLite
│   │   └── evolution.js          双Pass演化 (20轮触发)
│   ├── memory/
│   │   ├── store.js              分层存储 → SQLite
│   │   ├── recall.js             混合召回
│   │   ├── decay.js              衰减
│   │   └── curation.js           双Pass调和 (20轮触发)
│   └── character/
│       └── profiles.js           多角色 + 语音绑定
├── package.json
└── .env                          API Keys (不入git)
```

---

## 十五、开发顺序

| 阶段 | 内容 | 交付物 |
|------|------|--------|
| **P0** | config + logger + bus + processor + state | 配置加载+日志+骨架 |
| **P0** | player + queue (maxDepth=5) | 能播放PCM，能即时停止 |
| **P1** | vad + 唤醒词 + stt + 情感预检测 | 能检测语音+唤醒+转写 |
| **P1** | llm/gateway(单Provider) + classifier + cost | 能对话+分流+成本控制 |
| **P1** | tts/engine(单Provider) | 能合成语音 |
| **P2** | 串联全流程 + 启动/关闭 | 端到端语音对话 |
| **P2** | personality(OCEAN+冷启动) + memory(基础存储) | 有人格和记忆 |
| **P2** | 存储后端 SQLite 全接入 | 所有状态持久化 |
| **P3** | llm failover链 + 多Provider + 完整路由 | 双路径+故障切换 |
| **P3** | personality delta演化 + memory双Pass | 人格成长+记忆调和 |
| **P4** | character多角色 + queue升级(maxDepth=10) | 角色切换+管线完善 |
| **P4** | 健康端点 /health + metrics | 生产可观测 |

---

## 十六、参考来源

| 设计点 | 借鉴 |
|--------|------|
| 打断安全 | voice-core CancellationToken + processor_generation |
| 语音状态 | voice-core 无条件中断模式 |
| 模块通信 | Nexus VoiceBus → LightVoiceBus |
| 流式分类 | Nexus 3层过滤管道 |
| 多模态路径 | 能力驱动抽象 + Qwen-Omni首选 |
| 模型统一 | Nexus ChatCompletionResponse + failover链 |
| 人格基础 | LingYa OCEAN + Belief + 冷启动种子 |
| 人格演化 | eros_ai 双Pass delta (混合触发) |
| 记忆衰减 | Nexus e^(-λt) 指数衰减 |
| 记忆检索 | Nexus 情感共振 + 语义双路 |
| 记忆管理 | eros_ai Hot/Cold + 双Pass调和 |
| 角色管理 | Nexus CharacterProfile + 语音绑定 |
| 配置管理 | LingYa YAML + eros_ai pydantic-settings |
| 成本控制 | Nexus metering + 每日/会话预算 |
| 存储 | SQLite 独立部署方案 |

---

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|------|--------|----------|
| 1 (initial) | 7.3/10 | UX流程6分、运维6分、架构7分 → 3项修复 |
| 2 (fixed) | 9.0/10 | 所有维度 ≥ 8分 |

| 维度 | 修复前 | 修复后 | 变更 |
|------|--------|--------|------|
| 架构清晰度 | 7 | 9 | 拆分唤醒词模块 + 人格↔记忆交叉流 |
| 模块内聚性 | 8 | 9 | stt.js拆分情感检测 |
| 容错韧性 | 8 | 8 | — |
| 运维成熟度 | 6 | 8 | +systemd/Windows Service + 日志轮转 + 热加载 |
| 可扩展性 | 8 | 8 | — |
| 用户体验流程 | 6 | 9 | +4种关键时刻UX定义 |
| 文档完备性 | 8 | 8 | — |
| **总分** | **7.3** | **8.4** | +1.1 |

**VERDICT**: 方案达到可实施标准。剩余风险：多模态API稳定性(Qwen-Omni尚在beta)、自定义TTS音色复刻的训练周期。

NO UNRESOLVED DECISIONS

