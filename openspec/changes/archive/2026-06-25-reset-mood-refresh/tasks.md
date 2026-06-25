## 1. 修 reset handler

- [x] 1.1 `main.ts` 的 `IPC.reset` handler:`handle.reset()` 后补 `try { handle.persona.reload(); emit(IPC.mood, toMoodSummary(handle.persona.tone())); } catch {}`(对齐 turn:end/personaUpdate)。
- [ ] 1.2 (按现状定)若 reset 后状态栏未归位,顺带 `emit(IPC.state, 'idle')`。— **未做**:现状 reset 不改变 UI 状态机(无回合在跑、StateTracker 本就 idle),无需额外 emit;心情栏刷新已由 1.1 解决。

## 2. 校验

- [x] 2.1 desktop typecheck + bundle 构建通过;若有 ipc-contract 纯逻辑测试受影响则补。— typecheck + bundle 通过;reset handler 改动在 main.ts(electron 入口,无纯逻辑单测面),无需补测。
- [x] 2.2 `openspec validate reset-mood-refresh --strict` 通过。
- [ ] 2.3(真机)换段对话后看心情栏是否即时刷新(不等下一回合)。— **未做(需真机)**。
