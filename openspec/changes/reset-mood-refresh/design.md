## Context

`IPC.reset`(`main.ts:539`)只 `speakCtl?.stop()` + `handle.reset()`;`handle.reset()`(`app.ts:270-274`)换 sessionId + 重建 convo,**不碰显示引擎 handle.persona**。心情栏唯一常规刷新点是 `turn:end`(`main.ts:495-501`)的 reload+emit mood。reset 不产生 turn:end → 心情栏 stale。`personaUpdate`(`main.ts:657`)有补 emit mood,reset 没有(不对称)。`PersonaEngine.reload()`(本会话已加,engine.ts)只读、不 advance、不写回,安全。

## Goals / Non-Goals

**Goals:** reset 后心情栏即时反映当前 PAD;不崩;不改 reset 的记忆/心情续接语义。
**Non-Goals:** 不重建显示引擎(reload 即足);不改 app.ts;不引门控(纯修正)。

## Decisions

### D1:reset handler 补 reload + emit mood(对齐 personaUpdate/turn:end)
```ts
ipcMain.handle(IPC.reset, () => {
  speakCtl?.stop();
  handle.reset();
  try { handle.persona.reload(); emit(IPC.mood, toMoodSummary(handle.persona.tone())); } catch { /* §3.2 */ }
});
```
- 为何 reload:reset 不重建显示引擎,其内存快照可能落后于 store(虽 reset 不改 PAD,但保险同步);与 turn:end 同款,单一处理范式。
- 可选 `emit(IPC.state, 'idle')` 复位状态栏(若 reset 后状态未归位)——apply 时按现状定。

## Risks / Trade-offs
- 极小。reload 只读已验;try/catch 兜底。

## Migration Plan
- 纯修正,无门控/迁移。回滚=revert 几行。

## Open Questions
- 是否一并 emit state idle(看 reset 后状态栏现状)——apply 时定。
