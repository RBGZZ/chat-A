## 1. 配置与单一权威公式(§3.2,接缝先行)

- [x] 1.1 在 `packages/memory/src/config.ts` 的 `MemoryConfig` 增混合打分配置项:`keywordSigmoidSteepness`(陡度 s)、`keywordMidpointFraction`(中点比例,定 m);`DEFAULT_MEMORY_CONFIG`/`resolveMemoryConfig` 同步给内置默认(无 magic number,§3.2)
- [x] 1.2 在 `config.ts` 新增单一权威纯函数 `keywordScore(raw, queryTokenCount, cfg)`:查询长度自适应 sigmoid `1/(1+exp(-s·(raw-m)))`,`m = clamp(ceil(queryTokenCount·fraction), 1, queryTokenCount)`,返回 [0,1]
- [x] 1.3 在 `config.ts` 新增单一权威纯函数 `mixedRecallScore(signals, cfg)`:自适应分母 `min(Σ在场信号/在场信号数, 1)`;零信号(全部在场信号为 0)返回 0;复用现有 `recallScore` 作记忆强度路,不另起第二套衰减/强化
- [x] 1.4 在 `config.ts` 顶层定义 Russell 5×5 情感共振**常量矩阵**,并新增纯函数 `emotionResonance(pad, recordEmotion?, cfg)`:PAD/记忆各投影到扇区,O(1) 查表得 [0,1] 共振系数

## 2. 类型(纯加法,不依赖 persona)

- [x] 2.1 在 `packages/memory/src/types.ts` 增 memory 包本地最小类型 `Pad`(`{pleasure, arousal, dominance}`,各 [-1,1]),与 persona 包结构兼容但**不 import persona**(§3.1);`index.ts` 导出(纯加法)

## 3. 两 store 召回调用点同步(同契约,零漂移)

- [x] 3.1 `in-memory-store.ts` `recall`:候选过滤时算出每候选命中的去重 token 数,用 `mixedRecallScore`(关键词路 + 记忆强度路)替换原 `recallScore` 排序;签名追加**可选** `pad?: Pad` 末位入参(默认不启用情感共振);返回类型/次级键/强化时机不变
- [x] 3.2 `sqlite-store.ts` `recall`:LIKE 取候选后,JS 层用同一 `normalized includes token` 规则复算命中数(与 InMemory 零漂移),同样用 `mixedRecallScore` 排序;追加同款可选 `pad?` 入参;读失败仍优雅降级为空、强化不抛(§3.2)
- [x] 3.3 启用情感共振(传入 PAD)时,把 `emotionResonance` 作为一路在场信号融入 `mixedRecallScore`;两 store 行为一致

## 4. 契约 + golden 测试(确定性,无 LLM,§3.2)

- [x] 4.1 在 `packages/memory/test/contract.ts` 扩展共享契约:多 token 查询下"命中更多 token 者排更前"(关键词归一生效);单 token 查询排序仍由记忆强度驱动(向后兼容)
- [x] 4.2 契约:零信号门控——构造全零在场信号场景断言被丢弃;关键词/情感单路非零仍进候选池(不硬丢)
- [x] 4.3 契约:情感共振开关——不传 PAD 时排序 = 无情感基线(默认不启用);传 PAD 时按扇区矩阵小幅重排,且不主导(情感强但跑题不霸榜)
- [x] 4.4 在 `packages/memory/test/` 增 `config.ts` 公式 golden 单测:`keywordScore` 自适应中点、`mixedRecallScore` 自适应分母数值、`emotionResonance` 矩阵查表确定值
- [x] 4.5 确认两 store 跑同一套契约全绿(InMemory / SQLite 行为一致)

## 5. 验收

- [x] 5.1 worktree 根 `pnpm -r typecheck` 全绿(确认未改包不受影响,exactOptionalPropertyTypes 开)
- [x] 5.2 worktree 根 `npx vitest run` 全量全绿(确认 recall 行为变化不破其它包测试)
- [x] 5.3 `openspec validate mixed-recall-scoring --strict` 通过
