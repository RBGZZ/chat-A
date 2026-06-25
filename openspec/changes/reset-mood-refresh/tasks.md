## 1. 修 reset handler

- [ ] 1.1 `main.ts` 的 `IPC.reset` handler:`handle.reset()` 后补 `try { handle.persona.reload(); emit(IPC.mood, toMoodSummary(handle.persona.tone())); } catch {}`(对齐 turn:end/personaUpdate)。
- [ ] 1.2 (按现状定)若 reset 后状态栏未归位,顺带 `emit(IPC.state, 'idle')`。

## 2. 校验

- [ ] 2.1 desktop typecheck + bundle 构建通过;若有 ipc-contract 纯逻辑测试受影响则补。
- [ ] 2.2 `openspec validate reset-mood-refresh --strict` 通过。
- [ ] 2.3(真机)换段对话后看心情栏是否即时刷新(不等下一回合)。
