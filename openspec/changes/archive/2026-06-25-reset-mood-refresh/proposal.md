## Why

点"换段对话"(reset)后,desktop「心情」栏停在旧值,直到下一回合才刷新。根因(根因调查 C 确认):`IPC.reset` handler(`main.ts:539`)只 `speakCtl?.stop()` + `handle.reset()`,**不 reload 显示引擎、不 emit mood**;而 `personaUpdate` handler 应用后**有**补 `emit(IPC.mood, ...)`(`main.ts:657`)——reset 缺这条对称处理,是个小缺口。`reset()` 不重建 personaEngine 语义正确(换段保留长期记忆与 PAD 心情续接),问题纯在 UI 没被通知重读。

## What Changes

- **reset handler 补"刷新心情栏"**:`handle.reset()` 后 `handle.persona.reload()`(已存在、只读、安全)+ `emit(IPC.mood, toMoodSummary(handle.persona.tone()))`,与 `turn:end`/`personaUpdate` 同款。可选一并 `emit(IPC.state, 'idle')`。
- 单文件、几行;不动 app.ts;无门控(纯修 bug,行为更正确)。

## Capabilities

### Modified Capabilities
- `desktop-electron-frontend`: reset(换段对话)后刷新「心情」栏(reload 活 PAD + emit mood),不再停在旧值。

## Impact

- **改动代码**:`packages/desktop/src/main.ts`(IPC.reset handler,几行)。
- **canonical 接缝**:§3.1(降级——reload/emit 失败 try/catch 不崩)。不改 app.ts/核心。
- **风险**:极小;reload 已被 turn:end/speakReply 用、确认只读不写回。
