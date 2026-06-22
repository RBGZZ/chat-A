## Context

本轮 system prompt 现由 `packages/runtime/src/conversation.ts` 的 `#composeSystem(userText, toneFragment)` **硬编码三段拼接**:

1. `this.#skeleton`(= `buildSystemPrompt(seed)`,当前仅返回 `seed.identity`,来自 `packages/cognition/src/persona.ts`);
2. 记忆召回块——`this.#memory.recall(userText)` 命中时拼成 `[与当前输入相关的记忆]\n- ...`;召回抛错则吞掉走空(§3.2);
3. tone fragment——`this.#persona.tone().toneFragment`(来自 `packages/persona/src/tone.ts` 的 `renderToneFragment`)。

三段以 `\n\n` join 成 `system`;`messages` = `[...this.#memory.snapshot(), userMsg]`,直接交 `llm.stream({ system, messages })`。

canonical §5.4 要求把"prompt 组装"做成**优先级 Injection 接缝**:各来源(人格/记忆/tone,后续情绪/未了话题/异议)各做成一个 `PromptContributor` 返回 `{text, priority}`,按 priority 升序拼接(高优先级靠近末尾 = 最近注意力),超 context 预算从最旧历史裁剪,拼完各自 `cleanup()`;并要求**两档注入**(核心 pinned 永驻 vs 外围语义召回)与 **KV-cache 稳定性规则**(稳定前缀供复用、volatile 上下文以扁平 `[Context]` bullet 追加末条用户消息、弱模型不用 XML 标签)。

约束(承 §3.1/§3.2/行为即配置):模块只依赖类型化接缝;对外输出须与现状等价(契约测试验收);仅本地字符串运算、不得增加首字延迟;单来源故障须降级不崩;阈值/预算外置、prompt 版本化可热调。

## Goals / Non-Goals

**Goals:**
- 定义 `PromptContributor` / `PromptFragment` / `PromptContext` 接缝,把"谁往 prompt 注入什么"与"如何拼装/裁剪"解耦。
- 提供 `PromptAssembler`:优先级升序拼接 + context 预算裁剪(从最旧 history 裁)+ 逐个 cleanup + 单 contributor 故障降级。
- 把现有三段重构为三个内置 contributor(PersonaSkeleton / MemoryRecall / Tone),`Conversation.#composeSystem` 委托 assembler,**对外等价**。
- 落地两档注入(核心 pinned vs 外围召回)与 KV-cache 稳定性规则的结构基础。
- 留好后续 §7 行为 contributor(自传记忆/open threads/affectGuidance/stance)的挂载位。

**Non-Goals:**
- 真 embedding / 语义召回(P2,§5.5):沿用现有关键词 `recall`,只是包成 contributor。
- 具体行为 contributor 的实现(各自后续 change)。
- 精确 tokenizer:P1 预算估算用简单字符数 / 近似 token,只留接缝。
- KV-cache 之外的延迟优化。

## Decisions

### D1：接缝形状 —— `PromptContributor` 返回单个可空 `PromptFragment`

```ts
export interface PromptFragment {
  readonly text: string;
  /** 升序拼接:小=靠前(稳定/低注意力),大=靠近末尾(最近注意力)。 */
  readonly priority: number;
  /** 注入档:核心 pinned 永驻、不参与预算裁剪;外围可裁(§5.4)。默认 'peripheral'。 */
  readonly tier?: 'core' | 'peripheral';
}

export interface PromptContributor {
  /** 据组装上下文产出一段注入;无内容返回 null(不拼空段)。 */
  contribute(ctx: PromptContext): PromptFragment | null;
  /** 清理本轮一次性状态(§5.4);可选。 */
  cleanup?(): void;
}
```

`contribute` **同步**(与现状一致:骨架、tone、关键词 recall 均同步,无 await),不引入异步延迟。`null` 表示本轮无内容(如召回为空),assembler 跳过——等价于现状"召回为空就不拼记忆块"。

**为何返回单个 fragment 而非数组**:现状每来源恰好产出一段;单 fragment 最贴合且最易做等价契约。两档(core/peripheral)用 `tier` 字段表达,不必拆多 fragment。**替代**(每 contributor 返回 `PromptFragment[]`)被否:当前无来源需要多段,徒增复杂度;真有需要时可后续扩展(多注册一个 contributor 即可)。

**为何不实现 Neuro 的 force/priority 全套**(🅽 暂挂,§3.3):只取"priority 升序拼接 + 预算裁剪 + cleanup"这一最小子集,不引入 Neuro 专有调度机制。

### D2：`PromptContext` 字段 —— 严格据 conversation.ts 现有数据定义,不臆造

assembler 不自己取数;由 `Conversation` 把本轮已有的数据塞进 `PromptContext` 传入:

```ts
export interface PromptContext {
  readonly skeleton: string;                  // buildSystemPrompt(seed) 的结果(人格骨架)
  readonly recalled: readonly MemoryRecord[]; // memory.recall(userText) 结果(可空数组)
  readonly toneFragment: string;              // persona.tone().toneFragment
  readonly userText: string;                  // 本轮用户输入
  readonly history: readonly ChatMessage[];   // memory.snapshot() 滑窗
  /** volatile 上下文键值(时间戳/turnId 等),追加到末条用户消息(§5.4);P1 可空。 */
  readonly volatile?: ReadonlyArray<readonly [key: string, value: string]>;
}
```

- `recalled` 由 `Conversation` 调 `this.#memory.recall(userText)`,**保持现有 try/catch 降级**(召回抛错则传空数组);assembler 不直接碰 MemoryStore(维持接缝边界,§3.1)。
- `MemoryRecord` / `ChatMessage` 从 `@chat-a/memory` / `@chat-a/protocol` 复用,不新造类型。
- `history` 即 `memory.snapshot()`;裁剪发生在 assembler 内、对 history 切片,不改 MemoryStore。

### D3：`PromptAssembler.assemble(ctx)` 算法 —— 升序拼接 + 从最旧 history 裁

```ts
assemble(ctx: PromptContext): { system: string; messages: ChatMessage[] }
```

1. **收集**:对每个注册 contributor 调 `contribute(ctx)`;非空 fragment 收入列表。某 contributor 抛错 → try/catch 跳过该段、记一次 warn(§3.2),不影响其余。
2. **排序**:按 `priority` **升序**稳定排序(同 priority 保持注册序)。
3. **system 拼接**:core 档 fragment 始终保留;拼成 `system`(段间 `\n\n`,与现状一致)。**KV-cache 稳定**:稳定来源(骨架、core 档)放在前缀且字节级稳定,volatile 内容**不**进 system。
4. **messages 拼接 + 预算裁剪**:`messages = [...history, userMsg]`;`userMsg` 在末条追加 volatile `[Context]\n- key: value` bullet(扁平、无 XML 标签,§5.4)。估算 `system + messages` 总预算;**超上限则从 `history` 最旧端逐条丢弃**(§5.4),直到 ≤ 上限或 history 空。core 档与 userMsg 永不裁。
5. **cleanup**:对所有被调过的 contributor(无论是否产出)执行 `cleanup?.()`。

**预算估算(P1)**:`estimateTokens(s) ≈ ceil(charCount / K)`(K 外置,默认按混合中英取近似值),上限取 context 窗口的可配置比例(默认 ~90%,§5.4)。留 `TokenEstimator` 接缝,P2 换真 tokenizer 不改 assembler。**替代**(P1 直接接真 tokenizer)被否:增依赖与延迟,且 P1 现有 messages 远不到窗口上限,近似足够,单一权威估算公式避免漂移(行为即配置)。

**为何从最旧 history 裁、而非裁注入段**:§5.4 明确"拼到预算就从最旧历史裁剪";注入段(人格/记忆/tone)是当轮语义核心,历史滑窗最旧端冗余度最高,裁它对连续性损失最小,且与 KV-cache 稳定前缀目标一致(裁尾部历史不动稳定前缀)。

### D4：三个内置 contributor 映射现状(等价基线)

| contributor | 数据源(ctx 字段) | priority(相对) | tier | 等价于现状第几段 |
|---|---|---|---|---|
| `PersonaSkeletonContributor` | `skeleton` | 最小(靠前/最稳定) | core | 第 1 段 |
| `MemoryRecallContributor` | `recalled` | 中 | peripheral(核心事实档后续区分) | 第 2 段(空则返回 null) |
| `ToneContributor` | `toneFragment` | 最大(靠近末尾) | peripheral | 第 3 段 |

priority 取**离散常量**(如 100/500/900,留间隙供后续 §7 contributor 插入)、外置可调(行为即配置)。升序拼接后顺序 = 骨架 → 记忆 → tone,**与现状 `parts` 顺序一致**——这是等价契约的基础。`MemoryRecallContributor` 在 `recalled` 为空时返回 `null`,等价现状"无召回不拼块"。两档:core(pinned 用户名/过敏、Agent 名/core_belief)P1 由骨架/未来 core 档承载,MemoryRecall 默认外围;tier 字段为后续把"核心事实"标 core、令其免裁预留位。

### D5：`Conversation` 接入 —— 委托 assembler、对外等价

`#composeSystem` 改为:构造 `PromptContext`(填入现有 `skeleton`/`recalled`/`toneFragment`/`userText`/`history`)→ 调 `assembler.assemble(ctx)` → 返回 `{system, messages}`。`send()` 里 `system` 与 `messages` 改用 assembler 输出(`messages` 由 assembler 统一产出,含 volatile 追加)。assembler 实例在构造期建好(注册三个内置 contributor),稳定供 KV 复用。

**等价保证**:契约测试给定相同输入(同 seed/同 recall 结果/同 tone),断言新组装的 `system` 段顺序与内容、`messages` 结构与旧 `#composeSystem` + `[...snapshot, userMsg]` **结构等价**(P1 volatile 默认空时应字节等价;非空时断言仅末条用户消息尾部多 `[Context]` bullet)。

## Risks / Trade-offs

- [近似 token 估算与真实 tokenization 偏差] → P1 用近似 + 留 `TokenEstimator` 接缝;阈值取保守比例(~90%),P2 换真 tokenizer;现阶段 messages 量远未触顶,风险低。
- [重构破坏对外等价] → 以契约测试为验收门:相同输入下 system 段序/内容、messages 结构与旧实现等价;volatile 默认空保字节等价。
- [单 contributor 抛错影响整轮] → assembler 对每个 `contribute`/`cleanup` 包 try/catch,跳过该段、记 warn,回合继续(§3.2);至少骨架段保底,prompt 不空。
- [priority 数值散落成 magic number] → priority/预算比例/估算 K 全外置可配(行为即配置),用带间隙的离散常量,后续 §7 contributor 可插空。
- [volatile 进 system 破坏 KV-cache] → 设计强制 volatile 只追加到末条用户消息、不入 system;稳定前缀(骨架/core)字节级稳定;弱模型禁用 XML 标签用扁平 bullet(§5.4)。
- [裁剪从最旧 history 丢上下文连续性] → 仅裁滑窗最旧端(冗余度最高),core 段与当轮 userMsg 永不裁;预算上限可调以平衡连续性与窗口安全。

## Migration Plan

纯接缝化重构,无 schema / 持久化变更,无数据迁移。落地顺序:① cognition 加接缝类型 + 三个内置 contributor + assembler(纯函数式,先行契约/单测);② runtime `#composeSystem` 切到 assembler;③ 跑等价契约测试验收。回滚 = 还原 `#composeSystem` 直拼(assembler 与 contributor 为新增、不被其他模块依赖,移除无连带)。
