## Why

刚落地的 emotion-aware-voice("随心情说话")在 desktop **实际不生效**,因两处接线缺口:

1. **appraiser 没接进 desktop**:`CHAT_A_APPRAISER=llm` 只在 cli.ts 接(`cli.ts:50-52`);desktop 走 `assembleApp` 的 makeConvo,**没传 appraiser**(只 bus/llm/memory/personaSeed/personaStore/sessionId/outputLang)→ 一律默认关键词 appraiser,情绪几乎不随对话动(真机实测一句开心话后 mood 仍"平静")。
2. **朗读/显示读的是 stale PAD**:desktop mood 读 `handle.persona.tone()`(`main.ts:497`),那是个**永不 advance 的独立显示引擎**(`app.ts:190`);**活 PAD 在 Conversation 内部那个会 advance 的引擎里**(`conversation.ts:189/298`),没暴露。⇒ mood 栏 + emotion-aware-voice 读到的永远是开机心情,情绪音色不触发。

修这两处,"随心情说话"才能在 app 里真正按对话情绪起伏。

## What Changes

- **appraiser 接进核心装配**:`assembleApp` 按 `CHAT_A_APPRAISER=llm` 构造 `LlmAppraiser` 并经 makeConvo 传给 Conversation(Conversation 本就收 `TurnDeps.appraiser`,`conversation.ts:51/298,只是没传`);默认/缺省=不传=默认关键词 appraiser(逐字现状)。
- **活 PAD 可达**:让 desktop mood 读取与 emotion-aware-voice 朗读反映**当前活 PAD**。方案见 design(优先:`PersonaEngine.reload()` 从共享 store 重载;备选:Conversation 暴露 `tone()`)。回合后(turn:end / send 返回)刷新再读。
- **零回归**:不设 `CHAT_A_APPRAISER` → 默认 appraiser;活 PAD 刷新对"显示引擎本就等于 store"的情形无行为变化(只是不再 stale)。cli 不受影响。

## Capabilities

### New Capabilities
- `live-mood-appraiser-wiring`: 让 desktop 的情绪(PAD)随对话真实起伏并被 mood 显示/朗读读到的端到端接线(appraiser 接入 + 活 PAD 可达;门控/降级)。

### Modified Capabilities
- `runtime-assembly`: `assembleApp` 按 env 装配 appraiser(LLM/默认)并注入 Conversation。
- `persona-emotion`: `PersonaEngine` 支持从持久化 store 重载快照(reload),使只读引擎能反映另一引擎已保存的最新 PAD。
- `desktop-electron-frontend`: mood 显示与 emotion-aware-voice 朗读读取活 PAD(回合后刷新),不再用 stale 快照。

## Impact

- **改动代码**:`packages/client/src/assembly/app.ts`(appraiser 装配 + makeConvo 传参;含 reset/applyPersona/applyLang 重建路径)、`packages/persona/src/engine.ts`(reload)、`packages/desktop/src/main.ts`(turn:end 后刷新 + speakReply 读活 PAD)。
- **canonical 接缝**:§6(PAD 情绪)、§3.1(LLM 认知 opt-in、行为即配置、降级)。不改记忆/帧管线核心。
- **延迟**:LLM appraiser 每轮多一次评估调用(opt-in,默认关);reload 是一次 KV/SQLite 读(微秒级)。
- **依赖**:无新增(LlmAppraiser 已在 persona)。
- **非目标**:不改情绪映射本身(emotion-aware-voice 已落地);不动 cli 现有 appraiser 接法(只补 desktop/assembleApp);语音模式(voice-loop)的活 PAD 沿用其自身路径,本次聚焦文字朗读 + mood 显示。
