## 1. 配置与单一权威公式(行为即配置先行，§3.2）

- [x] 1.1 在 `packages/memory/src/config.ts` 的 `MemoryConfig` 增 `initialCloseness`(初值，默认 0.1 陌生起步)、`closenessHalfLifeDays`(衰减半衰期，默认 30)、`closenessUpK`(抬升系数，默认 0.1)、`closenessFloor`(下限，默认 0)；`DEFAULT_MEMORY_CONFIG` 同步，杜绝 magic number
- [x] 1.2 在 `config.ts` 增**单一权威纯函数**：`decayCloseness(closeness, updatedAtMs, atMs, cfg)`(`c·0.5^(days/H)`，days 取非负，夹到 `[floor,1]`，惰性算不写回)、`bumpClosenessValue(closeness, valencePos, cfg)`(`c + k·clamp(valence⁺,0,1)·(1−c)`，渐近饱和，夹到 `[floor,1]`)——两实现共用，防漂移；复用既有 `MS_PER_DAY`

## 2. memory 接缝 + 双实现(只动 roster/relationship_state 读写)

- [x] 2.1 在 `packages/memory/src/types.ts` 的 `MemoryStore` 增 `getCloseness(personId): number` / `getClosenessAt(personId, atMs): number` / `bumpCloseness(personId, valencePos, atMs): number`（含中文文档：读惰性衰减、抬升渐近饱和、读不写回、未知 person 幂等不抛）
- [x] 2.2 在 `packages/memory/src/sqlite-store.ts` 增 `#readRel(personId)`：读 `people.relationship_state` JSON → `{closeness, updatedAtMs}`(存储字段名 `closenessUpdatedAtMs`，映射内部 `updatedAtMs`，JSON 形状单一权威与 InMemory 一致)；解析失败/无记录返回 null
- [x] 2.3 `sqlite-store.ts` 实现 `getClosenessAt`(无记录→配置初值；有记录→`decayCloseness`)、`getCloseness`(=以 `#now()` 调用)、`bumpCloseness`(先取衰减后当前值→`bumpClosenessValue`→写回 `relationship_state` JSON；未知 person 命中 0 行幂等不抛；`#onError` 降级不抛)——**只动 relationship_state 读写，不碰 `#spread`/recall 主排序**
- [x] 2.4 在 `packages/memory/src/in-memory-store.ts` 增内部 `#closeness` Map(`personId → {closeness, updatedAtMs}`，镜像 SQLite relationship_state)，`getCloseness`/`getClosenessAt`/`bumpCloseness` 用同一组 `config.ts` 纯函数，与 SQLite 行为一致

## 3. closeness 喂 tone(persona-emotion，单向 → 表达)

- [x] 3.1 在 `packages/persona/src/tone.ts` 增 `CLOSENESS` 阈值常量(`midLow`/`midHigh`，外置)与三档文案 `CLOSENESS_TEXT`(near 更暖/愿分享/亲昵称呼；far 礼貌克制/少披露；mid 不追加)；`closenessBand(closeness)` 落档
- [x] 3.2 `renderToneFragment(pad, dials, closeness?)` 增**可选** `closeness` 形参：仅在提供时按档追加一行【关系】指令；**省略时逐字等于旧行为**（向后兼容）。closeness 单向影响表达，绝不反改 OCEAN/PAD
- [x] 3.3 在 `packages/persona/src/engine.ts` 的 `tone(closeness?)` 透传 closeness 到 `renderToneFragment`（exactOptional 安全，用条件展开仅在提供时附带实参，绝不显式传 undefined）

## 4. 回合接线(runtime 最小接线，不碰 voice-loop.ts)

- [x] 4.1 在 `packages/runtime/src/conversation.ts` 增 `primaryPersonId`(默认 'primary')；回合前 `getCloseness(primaryPersonId)` → `persona.tone(closeness)` 渲染语气（纯读，不挡首字）
- [x] 4.2 在 `packages/runtime/src/turn-shared.ts` 的 `finalizeTurn` 最小接线：回复之后、非首字热路径，按当轮情绪正向程度 `max(pad.pleasure, 0)` 调 `bumpCloseness(primaryPersonId, ..., at)`，失败不打断回合（§3.2）

## 5. 测试(确定性、无 LLM，§3.2)

- [x] 5.1 在 `packages/memory/test/contract.ts` 双实现共跑 golden：默认初值 + 抬升渐近饱和(两次满正向，第二次增量更小)+ 惰性衰减(过半衰期后 ≈ 半值)
- [x] 5.2 contract 增 `bumpCloseness valence≤0 不升只刷新基线`、`未知 person 不抛` 用例
- [x] 5.3 在 `packages/persona/test/tone.test.ts` 增：省略 closeness == 显式 undefined（逐字一致）；高 closeness 含"亲近"、低 closeness 含"克制"且二者不等
- [x] 5.4 在 `packages/runtime/test/closeness-wiring.test.ts` 增：高 closeness → 组装 system 含"亲近"、默认低 closeness → 含"克制"、回合收尾已 `bumpCloseness`（远期 getClosenessAt 随时间衰减 < 初值，证明已写入带时间戳的记录）

## 6. 数据迁移纪律 + 收尾验证

- [x] 6.1 旧库迁移纪律：`relationship_state`(v3 已建的可空列)无记录的 person 在读取路径**惰性兜底**配置初值——无需 backfill、零数据丢失；解析失败同样降级初值
- [x] 6.2 worktree 根 `pnpm -r typecheck` 全绿（memory 方法纯加法、tone/engine 形参可选，不级联破坏其它包）
- [x] 6.3 worktree 根 `npx vitest run` 全绿（closeness 演化 golden + tone 三档 + 回合接线 + 既有全量回归）
- [x] 6.4 自检与 canonical 一致：§6.1b closeness 演化喂 tone、§2.4 单向映射、§5.5 单一权威公式 + 惰性读不写回不引两套漂移、§3.2 参数全外置无 magic number + 零数据丢失；确认避让约束（未碰 `#spread`/recall 主排序、未碰 voice-loop.ts、未碰 providers/observability/interaction/autonomy）
