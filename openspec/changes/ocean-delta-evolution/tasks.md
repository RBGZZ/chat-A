## 1. 类型与配置(向后兼容加法)

- [ ] 1.1 `types.ts`:新增 `OceanDelta`(五维 number)、`OceanDeltaSnapshot`(turn/at/before/after/delta)、`OceanEvolveContext`、`OceanEvolver` 接缝。
- [ ] 1.2 `types.ts`:`PersonaSnapshot` 加**可选** `history?: readonly OceanDeltaSnapshot[]`(exactOptionalPropertyTypes:条件展开)。
- [ ] 1.3 `types.ts`:`PersonaConfig` 加 `evolutionEveryTurns`、`maxOceanDeltaPerStep`。
- [ ] 1.4 `defaults.ts`:`DEFAULT_PERSONA_CONFIG` 补默认值(20、0.01);加 `clamp01` 辅助(若无)。

## 2. 确定性内核(纯函数,golden)

- [ ] 2.1 `ocean-evolution.ts`:`clampOceanDelta(raw, max)`(每维钳 ±max,非有限→0)。
- [ ] 2.2 `ocean-evolution.ts`:`applyOceanDelta(ocean, delta)`(逐维相加后 clamp01)。
- [ ] 2.3 `ocean-evolution.ts`:`shouldEvolve(turn, everyTurns)`(turn>0 且整除)。
- [ ] 2.4 `ocean-evolution.ts`:`buildDeltaSnapshot(before, after, delta, turn, at)`(构造快照)。
- [ ] 2.5 `ocean-evolution.ts`:`isZeroDelta(delta)`(全零判定,供跳过)。

## 3. LLM 实现(opt-in + 降级)

- [ ] 3.1 `llm-ocean-evolver.ts`:`LlmOceanEvolver implements OceanEvolver`,照 `llm-appraiser.ts`(complete + tolerantJsonParse + 钳制 + 失败/无效→返回 null)。
- [ ] 3.2 `index.ts` 导出新模块与类型。

## 4. engine 接线(不改调用方)

- [ ] 4.1 `engine.ts`:`PersonaEngineOptions` 加可选 `oceanEvolver`;构造时保存(默认 undefined=关)。
- [ ] 4.2 `engine.ts`:`advance()` 内累积本周期 `recentUserTexts`;PAD 步进后,若 `shouldEvolve` 且有 evolver → `evolve` → 钳制 → 应用 → 追加 history → 写入快照;失败/null/全零跳过;触发后清空窗口。**advance 签名与 runtime 调用点不变**。

## 5. 持久化向后兼容

- [ ] 5.1 `store.ts`:`isValidSnapshot` 放宽——`history` 缺失合法;存在非数组则丢弃 history 字段而非丢整快照(人格状态绝不丢)。

## 6. 测试

- [ ] 6.1 golden:`clampOceanDelta` ±0.01 上限 + 非有限→0;`applyOceanDelta` clamp01。
- [ ] 6.2 golden:`shouldEvolve` 第 20 轮触发、第 19/21 轮不触发、turn=0 不触发。
- [ ] 6.3 golden:`buildDeltaSnapshot` 字段正确;`isZeroDelta`。
- [ ] 6.4 LLM:`LlmOceanEvolver` record-replay——合规 JSON(含越界)→ 钳制后 delta;乱码→null(降级)。
- [ ] 6.5 engine 集成:注入 FakeLlm evolver,跑满 20 轮 → OCEAN 微调且 history 新增一条;未满不变;未注入 evolver 全程 OCEAN 恒定。
- [ ] 6.6 持久化:旧快照(无 history)读回正常;history 损坏不丢 OCEAN/PAD/turn。

## 7. 验收

- [ ] 7.1 worktree 根 `pnpm -r typecheck` 全绿。
- [ ] 7.2 `npx vitest run` 全绿。
- [ ] 7.3 `openspec validate ocean-delta-evolution --strict` 通过。
