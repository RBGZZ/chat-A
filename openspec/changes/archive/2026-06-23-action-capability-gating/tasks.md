## 1. Action 接缝加 capability（packages/interaction）

- [ ] 1.1 `src/types.ts`：`Action` 新增可选 `capability?: string`（中文注释：声明所需能力，缺省=无需能力始终可用，§12.2）

## 2. ActionRegistry 能力门（packages/interaction）

- [ ] 2.1 `src/registry.ts`：构造参数 `constructor(capabilities?: ReadonlySet<string>)`，私有持有 `#capabilities: ReadonlySet<string> | undefined`
- [ ] 2.2 新增 `withCapabilities(set: ReadonlySet<string>): this`（设置/更新当前能力集，链式）
- [ ] 2.3 私有 `#isAuthorized(action)`：能力集 undefined → true；动作无 capability → true；否则 `set.has(capability)`
- [ ] 2.4 `toolDefs()`：先 `filter(#isAuthorized)` 再映射（隐藏未授权）
- [ ] 2.5 `execute()`：未知工具 → 既有 isError；已注册但未授权 → 新增 isError 容错拒绝（不抛、不调 perform、toolCallId 对齐、说明可区分）；其余逻辑不变
- [ ] 2.6 缺省（无能力集）行为逐字不变（向后兼容）

## 3. 新动作 date_diff（packages/interaction）

- [ ] 3.1 `src/actions/date-diff.ts`：`createDateDiffAction()` 返回确定性 Action，入参 `{from,to}`，算 UTC 天数差；不可解析→isError（不抛）；不声明 capability
- [ ] 3.2 `src/index.ts`：`export * from './actions/date-diff'`；`buildDefaultRegistry()` 注册 `date_diff`（不默认设能力集=全开）

## 4. 测试（Vitest，packages/interaction/test）

- [ ] 4.1 能力门：配能力集后 `toolDefs()` 只含已授权动作
- [ ] 4.2 能力门：未授权动作 `execute()` → isError 不抛、不调 perform、toolCallId 对齐
- [ ] 4.3 缺省全开兼容：无能力集时 toolDefs/execute 与现状一致
- [ ] 4.4 `withCapabilities` 更新能力集后过滤随之变化
- [ ] 4.5 `date_diff`：正例（相差天数）、反例（不可解析→isError）
- [ ] 4.6 同步现有断言：内置动作 size 4→5、toolDefs 含 `date_diff`（仅改 interaction 包内测试）

## 5. 验收

- [ ] 5.1 worktree 根 `pnpm -r typecheck` 全绿（exactOptionalPropertyTypes 开）
- [ ] 5.2 worktree 根 `npx vitest run` 全量全绿
- [ ] 5.3 `openspec validate action-capability-gating --strict` 通过
