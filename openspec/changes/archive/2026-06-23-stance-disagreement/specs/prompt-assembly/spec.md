## MODIFIED Requirements

### Requirement: PromptContext 据现有回合数据组装

`PromptAssembler.assemble` SHALL 接受由回合编排层填充的 `PromptContext`,字段 MUST 仅来自当轮已有数据:人格骨架 `skeleton`、记忆召回结果 `recalled`(`MemoryRecord[]`,可空)、tone fragment `toneFragment`、用户输入 `userText`、历史滑窗 `history`(`ChatMessage[]`),MAY 含本轮分歧检测结果 `stance`(由编排层调 `StanceDetector` 产出,缺省/无异议时省略)与 volatile 键值 `volatile`。assembler MUST NOT 自行访问 MemoryStore / Persona / StanceDetector 等具体实现(承 §3.1 接缝边界);取数、召回降级、stance 检测均由回合编排层负责。

#### Scenario: 由编排层注入上下文而非 assembler 自取

- **WHEN** 回合编排层调用 `assemble(ctx)`
- **THEN** assembler 仅消费 `ctx` 中字段产出结果,不直接调用 `memory.recall` / `stanceDetector.detect` 等具体实现

#### Scenario: 召回为空时上下文合法

- **WHEN** 记忆召回结果为空数组
- **THEN** `ctx.recalled` 为空,组装正常进行且不产出记忆注入段

#### Scenario: 无 stance 时上下文合法

- **WHEN** 本轮无分歧检测结果(`ctx.stance` 省略或为空)
- **THEN** 组装正常进行,DissentContributor 据 assertiveness 决定是否仍注入反谄媚基线,但不产出针对具体观点的异议段
