# chat-A 语音管线 v2：Qwen-Omni 多模态 + 自定义TTS

> 变更：用 Qwen-Omni 多模态模型替代 STT + LLM
> 保留：自定义TTS音色复刻 + voice-core打断安全 + 流式分类

---

## 一、管线对比：变简单了多少

```
v1 (传统):  Mic → VAD → STT → LLM → 流式分类 → TTS → 播放
            4段串行      各自独立引擎       STT后丢失语气信息

v2 (多模态):Mic → VAD → Qwen-Omni → 流式分类 → TTS → 播放
            2段           一口吃掉STT+LLM    音频直达模型保留语气
```

**省掉的模块**：STT引擎（Whisper/SenseVoice）、LLM引擎（独立的对话生成）

**新增的能力**：模型从原始音频中直接感知情绪/语速/语调

## 二、为什么这个组合恰好解决了之前的矛盾

```
自定义TTS必须保留 → Qwen-Omni只做输入端(音频→文本)
                    TTS端完全独立，音色不受影响

语气情绪很重要   → 原始音频直接送入模型
                    模型听到的是真实语调，不是STT转写后的扁平文本

流式打断必须稳   → Qwen-Omni输出的是文本流
                    文本流可以被CancellationToken打断
                    比打断音频流简单得多
```

## 三、Qwen-Omni 的实际工作方式

```
输入: 原始PCM音频 (16kHz mono) + 系统提示 + 记忆上下文
输出: 流式文本 + 情绪标注

模型内部做的事(不需要我们管):
  1. 听懂说了什么 (替代STT)
  2. 从语气中感知情绪 (愤怒/悲伤/开心/焦虑...)
  3. 理解上下文生成回复 (替代LLM)
  4. 在回复中嵌入情绪标签 [expr:happy]
```

**系统提示中注入情绪感知指令**：

```
你是一个语音对话陪伴AI。
你会收到用户的原始音频，请：
1. 理解用户说的话
2. 从语气中感知用户的情绪状态（语速、音调、停顿、音量）
3. 用符合当前情境的语气回复
4. 在回复末尾附加情绪标签：[user_emotion:xxx]
```

## 四、改造后的核心循环

```
用户说话
  │
  ▼
VAD (Silero, 本地)  ← 永远在跑，不听模型
  │
  ├─ 检测到语音开始 → 如果AI在说话 → 打断！
  │   bus.emit('interrupted') → processor.allocate()
  │
  ├─ 持续收集音频buffer
  │
  ▼ 静音1.5秒 → 语音结束
  │
  ▼
VoiceProcessor.allocate()  ← generation++
  │
  ▼
Qwen-Omni API调用:
  POST /v1/chat/completions
  {
    model: "qwen-omni",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: [
          { type: "audio",  audio: base64PCM },
          { type: "text",   text: "（请从语气中感知情绪）" }
      ]}
    ],
    stream: true
  }
  │
  ▼ 流式响应 (SSE)
  │
  ▼
每收到一个delta → 流式分类器:
  ├─ 显示文本 → UI气泡
  ├─ 口语文本 → AudioQueue → 自定义TTS → 播放
  └─ 情绪标签 [user_emotion:sad] → 人格引擎更新
```

## 五、情绪感知的双通道

这是多模态模型带来的最大优势——情绪感知从"猜测"变成"感知"：

```
v1 (只有文本):
  用户说"我没事" → LLM只能根据文字判断
    → 可能误判为"真的没事"
    → 丢失了语气中的颤抖和停顿

v2 (有音频):
  用户说"我没事"(声音发颤、语速缓慢)
    → Qwen-Omni听到的是真实语调
    → 模型回复: "你的声音听起来有点低落，我在这里陪你。[user_emotion:sad]"
```

**情绪流向**：

```
Qwen-Omni输出:
  "你听起来不太开心呢，想跟我说说吗？[user_emotion:sad-7]"

流式分类器解析:
  display: "你听起来不太开心呢，想跟我说说吗？"
  speech:  "你听起来不太开心呢，想跟我说说吗？"
  emotion: { user: 'sad', intensity: 7 }

人格引擎:
  → 更新用户情绪快照
  → 调节共同调节策略
  → 影响下一次系统提示中的语气指导
```

## 六、与 voice-core 打断安全模式的兼容

好消息：从打断安全的角度，多模态模型和普通LLM完全一样——都是文本流。

```
Qwen-Omni的流式响应:
  data: {"choices":[{"delta":{"content":"你"}}]}
  data: {"choices":[{"delta":{"content":"今天"}}]}
  data: {"choices":[{"delta":{"content":"开心吗"}}]}
  ...

我们的Attach:
  const response = await fetch(qwenOmniAPI, { 
    body: payload, 
    signal: this.controller.signal  ← AbortController
  })

  // 用户打断 → controller.abort() → fetch立即断开
  // 与打断普通LLM完全相同的机制
```

**唯一的额外注意**：Qwen-Omni的音频处理有首token延迟（需要先"听完"音频）。这个延迟期间如果用户打断：

```javascript
// 在等待首token期间，VAD仍在运行
// 如果检测到新语音 → controller.abort() → 旧请求取消
// → allocate() → 新音频发送 → 新请求开始
```

## 七、改造后的模块清单

```
保留:
  ✅ bus.js              LightVoiceBus (不变)
  ✅ processor.js        VoiceProcessorManager (不变)
  ✅ vad.js              VAD + EchoGuard (不变)
  ✅ player.js           AudioPlayer即时停止 (不变)
  ✅ queue.js            AudioQueue反压 (不变)
  ✅ classifier.js       流式分类器 (不变)
  ✅ personality/        人格引擎 (增强: 接收音频情绪)
  ✅ memory/             记忆引擎 (不变)
  ✅ character/          角色管理 (不变)

删除:
  ❌ stt.js              STT引擎 (Qwen-Omni替代)
  ❌ llm/gateway.js      LLM网关 (Qwen-Omni替代)
  ❌ llm/providers/      多LLM Provider (Qwen-Omni替代)

新增:
  🆕 multimodal/
      omni-client.js     Qwen-Omni API客户端
      emotion-extractor.js  从响应中提取情绪标签
```

## 八、模块数从11个减到9个

```
v1: VAD STT LLM TTS Player Bus Processor 分类 人格 记忆 角色 = 11
v2: VAD     Omni TTS Player Bus Processor 分类 人格 记忆 角色 = 9
```

## 九、潜在风险与对策

| 风险 | 对策 |
|------|------|
| Qwen-Omni首token延迟高(音频处理3-5秒) | 思考期间VAD保持活跃，可打断 |
| Qwen-Omni API不稳定/限流 | 保留LLM降级路径：音频→本地STT→文本LLM |
| Qwen-Omni情绪感知不准确 | 人格引擎只用情绪标签做参考，权重低(0.3)，依赖多轮确认 |
| 音频上传带宽/成本 | 用VAD精准切分，只上传有效语音段；可降采样到8kHz |
| 只有单一Provider无failover | 降级路径保证可用性：Omni失败→STT+LLM |

## 十、降级路径（保底方案）

```javascript
async processUtterance(audioBuffer) {
  try {
    // 主路径: Qwen-Omni多模态
    return await this.qwenOmni.generate(audioBuffer, { signal })
  } catch (err) {
    if (err.isRetryable) {
      // 降级: 本地STT + 文本LLM
      const text = await this.fallbackSTT.transcribe(audioBuffer)
      return await this.fallbackLLM.generate(text, { signal })
    }
    throw err
  }
}
```
