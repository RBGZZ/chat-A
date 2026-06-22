## 1. 接缝类型（packages/cognition）

- [x] 1.1 定义 `PromptFragment { text: string; priority: number; tier?: 'core' | 'peripheral' }`（升序拼接、tier 缺省外围）
- [x] 1.2 定义 `PromptContributor { contribute(ctx): PromptFragment | null; cleanup?(): void }`（同步、无 I/O）
- [x] 1.3 定义 `PromptContext { skeleton; recalled: MemoryRecord[]; toneFragment; userText; history: ChatMessage[]; volatile?: ReadonlyArray<[string,string]> }`，类型复用 `@chat-a/memory` / `@chat-a/protocol`
- [x] 1.4 定义 `TokenEstimator` 接缝与预算配置（上限比例、估算 K 外置可配，行为即配置）；P1 提供字符数/近似 token 默认实现
- [x] 1.5 从 `packages/cognition` 导出上述类型（index）

## 2. PromptAssembler（packages/cognition）

- [x] 2.1 实现 `PromptAssembler`：构造期注册 contributor 列表 + 注入 `TokenEstimator`/预算配置
- [x] 2.2 `assemble(ctx)`：收集各 contributor 非空 fragment；`contribute` 抛错 → try/catch 跳过该段 + 记 warn（§3.2），不中断
- [x] 2.3 按 priority **升序**稳定排序（同 priority 保注册序）→ 拼 `system`（段间 `\n\n`，与现状一致）；`tier:'core'` 段始终保留
- [x] 2.4 拼 `messages = [...history, userMsg]`；volatile 以扁平 `[Context]\n- key: value` bullet 追加末条用户消息，**不**用 XML 标签（§5.4）
- [x] 2.5 预算裁剪：估算 `system + messages` 超上限则从 `history` 最旧端逐条丢弃；core 段与当轮 userMsg 永不裁（§5.4）
- [x] 2.6 组装结束对所有被调用过的 contributor 执行 `cleanup?.()`；cleanup 抛错不影响其余

## 3. 三个内置 contributor（packages/cognition）

- [x] 3.1 `PersonaSkeletonContributor`：取 `ctx.skeleton`，priority 最小（靠前/最稳定），`tier: 'core'`
- [x] 3.2 `MemoryRecallContributor`：`ctx.recalled` 非空时拼 `[与当前输入相关的记忆]\n- ...`，空则返回 `null`；priority 中，外围档
- [x] 3.3 `ToneContributor`：取 `ctx.toneFragment`，priority 最大（靠近末尾），外围档
- [x] 3.4 priority/预算比例/估算 K 用带间隙的离散常量并外置可配（如 100/500/900，预留 §7 后续 contributor 插空）

## 4. Conversation 接入（packages/runtime）

- [x] 4.1 构造期建 `PromptAssembler` 实例（注册三个内置 contributor），实例稳定供 KV 复用
- [x] 4.2 `#composeSystem` 改为构造 `PromptContext`（填现有 `skeleton`/`recalled`/`toneFragment`/`userText`/`history=snapshot()`）并委托 `assembler.assemble`；保留召回 try/catch 降级（抛错传空数组）
- [x] 4.3 `send()` 改用 assembler 输出的 `{ system, messages }`（messages 含 volatile 追加），替换原 `[...snapshot(), userMsg]` 直拼
- [x] 4.4 确认不改动记忆/人格读写路径与持久化 schema（纯接缝化、非破坏）

## 5. 契约与单元测试（Vitest）

- [x] 5.1 等价契约测试：相同输入（同 seed/同 recall 结果/同 tone）下新 `system` 段序（骨架→记忆→tone）与内容、`messages` 结构与旧 `#composeSystem` 结构等价；volatile 为空时字节等价
- [x] 5.2 优先级排序测试：低/中/高 priority 段按升序拼接（高靠末尾）；同 priority 保持注册序
- [x] 5.3 预算裁剪测试：超上限从最旧 history 裁;core 段与当轮 userMsg 永不裁
- [x] 5.4 两档注入测试:core(骨架)每轮必注入;外围召回命中则注入、无命中不注入
- [x] 5.5 KV-cache 稳定性测试:同人格配置连续两轮 system 前缀字节级一致;volatile 以扁平 bullet 追加末条用户消息且无 XML 标签
- [x] 5.6 降级测试:单 contributor `contribute`/`cleanup` 抛错则跳过该段、记录错误、其余正常、回合不中断
- [x] 5.7 召回为空测试:`MemoryRecallContributor` 返回 `null`,不拼空记忆段
