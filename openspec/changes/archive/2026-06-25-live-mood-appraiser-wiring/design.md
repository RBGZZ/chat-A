## Context

emotion-aware-voice 已落地但 desktop 不生效,两处接线缺口(已源码核实):
- **appraiser**:`TurnDeps.appraiser` 存在且 Conversation 内部引擎会用(`conversation.ts:51,298-300`),但 `assembleApp.makeConvo` 不传(`app.ts:207-216`);`CHAT_A_APPRAISER=llm` 只在 cli.ts 接(`cli.ts:50-52`)。
- **stale PAD**:desktop mood 读 `handle.persona.tone()`=独立显示引擎(`app.ts:190`),它**永不 advance**;活 PAD 在 Conversation 内部引擎(`conversation.ts:189`,每轮 advance+save 到共享 personaStore)。`PersonaEngine.tone()` 用内存 `#snapshot`、**不重载**(`engine.ts:109-118`)→ 显示引擎恒为开机值。两引擎共享同一 `personaStore`(`app.ts:184`)。

涉及 §6(PAD)、§3.1(LLM 认知 opt-in/降级/行为即配置)。

## Goals / Non-Goals

**Goals:**
- `CHAT_A_APPRAISER=llm` 在 desktop 生效,PAD 随对话起伏。
- mood 显示 + emotion-aware-voice 朗读读到活 PAD。
- 默认零回归;cli 不受影响;降级安全。

**Non-Goals:**
- 不改情绪映射(emotion-aware-voice 已有);不改 cli 现有 appraiser 接法;voice-loop 活 PAD 沿用自身路径(本次聚焦文字朗读 + mood 显示);不引入 mood 总线事件协议(避免扩 protocol)。

## Decisions

### D1:appraiser 经 assembleApp 装配并注入 makeConvo
`app.ts` 读 `CHAT_A_APPRAISER`(镜像 cli.ts:50);`=llm` → `new LlmAppraiser({ provider: llm })`;makeConvo 里 `...(appraiser ? { appraiser } : {})` 透传给 Conversation。
- **为何**:Conversation 已支持 `TurnDeps.appraiser`,只差装配层传入。最小、对称 cli。
- 注意:makeConvo 是闭包,appraiser 在 assembleApp 作用域建一次即可(reset/applyLang 重建 convo 时闭包仍捕获同一 appraiser → 自动续接)。**核对 applyPersona/applyLang 的 convo 重建走的是同一 makeConvo**(`app.ts:261,271,290`)。

### D2:活 PAD —— 优先 `PersonaEngine.reload()`,desktop 回合后刷新
给 `PersonaEngine` 加 `reload()`:`#snapshot = this.#store.load() ?? this.#snapshot`(只读 store、不 advance、不写回)。desktop 在 `turn:end`(`main.ts:495`)与 speakReply 取数前 `handle.persona.reload()`,再 `tone()`。
- **为何 reload 而非"让 tone() 每次重载"**:只读显示引擎才需要重载;Conversation 内部引擎自持内存权威,不能被动重载(会干扰其 advance 流)。reload 显式、范围可控。
- **为何不暴露 Conversation.tone()(备选)**:也可行(读内部活引擎),但要给 Conversation 加公开 getter + desktop 改读 handle.convo;reload 改动面更小且复用既有 handle.persona 取数点。**取 reload 为主**。
- 共享 store 保证:Conversation 内部引擎 advance 后 `store.save`(`engine.ts:163`),reload 从同一 store 读到 → 同步。
- handle 需暴露 reload 入口:`handle.persona` 是 getter 返回引擎,直接 `handle.persona.reload()` 即可(engine 自带方法)。

### D3:门控 + 降级
- appraiser:默认不注入(关键词)= 逐字现状。
- reload:失败(store 读异常)→ try/catch 保留旧快照,mood/朗读不崩(§3.2)。
- emotion-aware-voice 朗读已有 try/catch 读 tone(emotion-aware-voice 的 speakReply 实现),在其前 reload 即可。

## Risks / Trade-offs

- **LLM appraiser 每轮多一次调用**(延迟/成本)→ opt-in 默认关;只在用户显式开时付出。
- **reload 时机/竞态**:speakReply 在 `convo.send` 返回后执行(此时内部引擎已 advance+save),reload 必读到新值;turn:end handler 同理在回合后。无并发写显示引擎(它只读)。
- **reload 引入 store 读**:每轮一次 KV/SQLite 读,微秒级,不进首字热路径。
- **applyPersona 重建显示引擎**:applyPersona 已 `new PersonaEngine` 重建(`app.ts:269`)→ 自然取 store 最新;与 reload 不冲突。

## Migration Plan

- 纯增量 + 默认行为不变:不设 `CHAT_A_APPRAISER` → 关键词 appraiser;reload 只是消除 stale,不改"本就同步"情形产出。无 schema/数据迁移。
- 回滚=去 env / revert;reload 方法即便存在,不调用则无影响。

## Open Questions

1. reload vs 暴露 Conversation.tone():D2 取 reload;apply 时若发现 handle.persona 取数点过多,可改 Conversation getter(等价)。
2. 是否顺带给 voice-loop 活 PAD(non-goal,后续)。
