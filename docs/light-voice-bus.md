# 轻量 VoiceBus 参考实现

> 来源：对比 voice-core(紧耦合) + Nexus(45事件+Effects模式) 后提炼
> 适用：Node.js 单进程、5-15个模块的语音对话系统

---

## 实现

```javascript
class LightVoiceBus {
  #listeners = new Map()
  #history = []
  #maxHistory = 100

  // ── 核心事件类型（6种覆盖全流程）──
  static Events = {
    SESSION_START:   'session:start',
    USER_SPEECH_END: 'user:speech_end',    // { text }
    AI_START_SPEAK:  'ai:start_speaking',  // { text }
    AI_STOP_SPEAK:   'ai:stop_speaking',   // { reason }
    INTERRUPTED:     'interrupted',        // { by: 'user'|'system' }
    ERROR:           'error',              // { source, message }
  }

  emit(type, data = {}) {
    const entry = { type, data, time: Date.now() }
    this.#history.push(entry)
    if (this.#history.length > this.#maxHistory) this.#history.shift()

    for (const fn of this.#listeners.get(type) ?? []) {
      try { fn(data) } catch (e) { console.error(`[Bus] ${type}:`, e) }
    }
    for (const fn of this.#listeners.get('*') ?? []) {
      try { fn(type, data) } catch (e) { console.error('[Bus] *:', e) }
    }
    return entry
  }

  on(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set())
    this.#listeners.get(type).add(fn)
    return () => this.#listeners.get(type).delete(fn)  // 返回取消函数
  }

  onAny(fn) { return this.on('*', fn) }

  get history() { return [...this.#history] }

  destroy() {
    this.#listeners.clear()
    this.#history.length = 0
  }
}
```

## 使用

```javascript
const bus = new LightVoiceBus()

// STT 模块
bus.on(LightVoiceBus.Events.USER_SPEECH_END, ({ text }) => {
  llm.generate(text)
})

// 打断处理器
bus.on(LightVoiceBus.Events.INTERRUPTED, () => {
  player.stop()
  tts.abort()
})

// 全局日志
bus.onAny((type, data) => {
  logger.info({ type, ...data })
})

// 清理
const unsub = bus.on('ai:start_speaking', handler)
// 不再需要时
unsub()
```

## 设计原则

| 取自 | 借鉴 | 不取 |
|------|------|------|
| **Nexus** | on/onAny/onTransition 订阅层级、handler try/catch 包裹、history 记录、unsubscribe 返回 | 45种事件类型、Effects描述符、13状态机 |
| **voice-core** | 简洁 | 紧耦合(所有逻辑在Orchestrator) |

- **6事件覆盖全流程**，不加不必要的事件类型
- **每个handler被try/catch包裹**，一个模块崩溃不影响其他
- **on()返回unsubscribe函数**，防止内存泄漏
- **history保留最近100条**，调试时直接看bus.history
