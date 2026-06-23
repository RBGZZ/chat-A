## 1. 对话风格纪律 contributor（§7#4）

- [x] 1.1 `cognition/prompt/types.ts`:`PromptContext` 增可选 `expressiveness?: number`（[0,1]，由编排层据人格旋钮填入；缺省回落中性档）
- [x] 1.2 `cognition/prompt/config.ts`:`PROMPT_PRIORITY.style`（取 920，tone 之后、dissent 之前，带注释）；`STYLE_EXPRESSIVENESS = { reservedCeil, expressiveFloor }` 分档常量（externalized，无 magic number）
- [x] 1.3 `cognition/prompt/contributors.ts`:`StyleDisciplineContributor`——每轮注入硬纪律（话短/口语/禁"作为AI…"/禁过度解释/别像写文章）+ 据 expressiveness 分档的"口头禅·语气词"放开程度；tier='peripheral'，priority=style；同步无 I/O
- [x] 1.4 `cognition/prompt/index.ts` 经 `export *` 自动导出（无需手改）

## 2. 做实 self_notions（§7#3）

- [x] 2.1 `persona/seed.ts`:`XIAOXUE_SEED.selfNotions` 填 3-4 条真实观点（`{ topic, position }`，符合 SelfNotion 类型）
- [x] 2.2 `persona.example.yaml`:`selfNotions` 示例区对齐补充，与种子风格一致

## 3. 回合接线（runtime）

- [x] 3.1 `runtime/conversation.ts`:assembler 注册列表加一行 `new StyleDisciplineContributor()`（+ import）；**不动其它逻辑**

## 4. 测试（golden + 命中）

- [x] 4.1 `StyleDisciplineContributor` golden:含硬纪律关键句（禁"作为AI"、话短口语）；priority=style；tier=peripheral
- [x] 4.2 `StyleDisciplineContributor` 分档可观测:含蓄 / 中性 / 外放三档文本互不相同；缺省 expressiveness=中性档
- [x] 4.3 `DefaultStanceDetector` 用 `XIAOXUE_SEED.selfNotions` 能命中（如"咖啡"/"熬夜" 话题命中、无关话题不命中）

## 5. 收尾

- [x] 5.1 worktree 根 `pnpm -r typecheck` + `npx vitest run` 全绿
- [x] 5.2 `openspec validate style-and-self-notions --strict` 通过
