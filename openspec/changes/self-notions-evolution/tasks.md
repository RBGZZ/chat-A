## 1. 类型与配置(向后兼容加法)

- [x] 1.1 `types.ts`:`SelfNotion` 加**可选** `strength?: number`、`affirmCount?: number`(条件展开,不写 undefined)。
- [x] 1.2 `types.ts`:新增 `SelfNotionStrengthDelta`、`SelfNotionSnapshot`、`SelfNotionEvolveContext`、`SelfNotionEvolver` 接缝、`SelfNotionsState`、`SelfNotionStore` 接缝。
- [x] 1.3 `defaults.ts`:新增 `SELF_NOTION_BASE_STRENGTH`(基线强度)、`maxStrengthDeltaPerStep`(单次上限)、`SELF_NOTION_STRENGTH_FLOOR`(stance 压制门槛)、`SELF_NOTIONS_SCHEMA_VERSION`。

## 2. 确定性内核(纯函数,golden)

- [x] 2.1 `self-notions.ts`:`clampStrengthDelta(raw, max)`(钳到 [0,+max],非有限→0,只增不减)。
- [x] 2.2 `self-notions.ts`:`applyStrengthDelta(notion, delta)`(strength=clamp01(base+delta),affirmCount+1)。
- [x] 2.3 `self-notions.ts`:`buildSelfNotionSnapshot(before, after, delta, turn, topicKey, at)`。
- [x] 2.4 `self-notions.ts`:`topicKeyOf(notion)`(topic 首关键词归一为键,供 delta 定位)。
- [x] 2.5 `self-notions.ts`:`migrateSelfNotionsState(parsed)`(无版本旧形态→v1;notions 损坏→null;history 损坏→丢字段不丢 state)。

## 3. 持久化 + 编排(复用 KvLike,独立 key)

- [x] 3.1 `self-notions.ts`:`createKvSelfNotionStore(kv)`(独立 key `persona:self_notions`,load 解析+迁移,save 序列化;失败→null 回落)。
- [x] 3.2 `self-notions.ts`:`SelfNotionsManager`——构造接 seedNotions + 可选 store + 可选 evolver + 可选 now;init 时 load 有则用、无则用种子(有 store 则 seed 落库一次);`current()` 返回当前立场;`advance(userText, turn)` opt-in 演化(失败/null/全零跳过、不抛)。
- [x] 3.3 `index.ts`:导出 `self-notions.ts`。

## 4. stance 读演化后立场(默认不变)

- [x] 4.1 `stance.ts`:`DefaultStanceDetector` 加可选 `strengthFloor`;命中后对**显式低强度**立场在低 assertiveness 下更趋沉默;缺省强度按"基线足够"→ 命中行为与当前完全一致(不破现有测试)。

## 5. 测试

- [x] 5.1 golden:`clampStrengthDelta`(上限 + 非有限→0 + 负数→0 只增不减);`applyStrengthDelta`(clamp01 + affirmCount+1 + 缺省 strength 用基线)。
- [x] 5.2 golden:`buildSelfNotionSnapshot` 字段;`topicKeyOf` 归一。
- [x] 5.3 迁移:无版本旧 `SelfNotion[]` → v1 补缺省不丢 topic/position;notions 损坏→null;history 损坏→丢 history 不丢 notions。
- [x] 5.4 持久化往返:seed→store→重启读回(含强度+history);无 store/无 evolver → `current()` 严格等于种子(等价当前)。
- [x] 5.5 演化:注入固定 evolver,确立某立场 → strength 上升(≤单次上限)、affirmCount+1、history+1;全零/null/失败 → 不变、不抛;delta 超上限被钳。
- [x] 5.6 stance:缺省强度命中行为与当前一致(复用现有断言);显式低强度立场在低 assertiveness 下被压制。

## 6. 验收

- [x] 6.1 worktree 根 `pnpm -r typecheck` 全绿。
- [x] 6.2 `npx vitest run` 全绿(现有 stance/persona 测试不破)。
- [x] 6.3 `openspec validate self-notions-evolution --strict` 通过。
