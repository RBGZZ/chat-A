# prompt-assembly Specification

## Purpose
TBD - created by archiving change prompt-contributor-seam. Update Purpose after archive.
## Requirements
### Requirement: PromptContributor 注入接缝

系统 SHALL 提供 `PromptContributor` 接缝:`contribute(ctx): PromptFragment | null`,可选 `cleanup(): void`。`PromptFragment` MUST 含 `text: string` 与 `priority: number`,MAY 含注入档 `tier: 'core' | 'peripheral'`(缺省按外围)。各注入来源(人格骨架、记忆召回、tone,及后续行为项)MUST 各实现为一个 contributor;`contribute` 返回 `null` 表示本轮无内容、MUST NOT 拼入空段。`contribute` MUST 同步、MUST NOT 引入额外 I/O 或网络调用(承 §3.2 延迟预算)。

#### Scenario: contributor 产出带优先级的片段

- **WHEN** 一个 contributor 对给定 `PromptContext` 有内容产出
- **THEN** 返回 `{ text, priority }`(可带 `tier`),供 assembler 据 priority 定位

#### Scenario: 无内容返回 null 不拼空段

- **WHEN** 某 contributor 对当前上下文无可注入内容(如记忆召回为空)
- **THEN** `contribute` 返回 `null`,assembler 跳过该来源、不在 prompt 中留空段

### Requirement: PromptContext 据现有回合数据组装

`PromptAssembler.assemble` SHALL 接受由回合编排层填充的 `PromptContext`,字段 MUST 仅来自当轮已有数据:人格骨架 `skeleton`、记忆召回结果 `recalled`(`MemoryRecord[]`,可空)、tone fragment `toneFragment`、用户输入 `userText`、历史滑窗 `history`(`ChatMessage[]`),MAY 含 volatile 键值 `volatile`。assembler MUST NOT 自行访问 MemoryStore / Persona 等具体实现(承 §3.1 接缝边界);取数与既有降级(召回抛错传空数组)由回合编排层负责。

#### Scenario: 由编排层注入上下文而非 assembler 自取

- **WHEN** 回合编排层调用 `assemble(ctx)`
- **THEN** assembler 仅消费 `ctx` 中字段产出结果,不直接调用 `memory.recall` 等具体实现

#### Scenario: 召回为空时上下文合法

- **WHEN** 记忆召回结果为空数组
- **THEN** `ctx.recalled` 为空,组装正常进行且不产出记忆注入段

### Requirement: PromptAssembler 优先级升序拼接

`PromptAssembler` SHALL 收集所有非空 fragment,按 `priority` **升序**稳定排序(小值靠前 = 稳定/低注意力,大值靠近末尾 = 最近注意力),同 priority 保持注册顺序,据此拼成 `system`(段间分隔与现状一致)。assembler MUST 返回 `{ system, messages }`。

#### Scenario: 高优先级靠近末尾

- **WHEN** 多个 contributor 分别以低、中、高 priority 产出片段
- **THEN** 拼接结果中低 priority 段靠前、高 priority 段靠近末尾

#### Scenario: 同优先级保持注册顺序

- **WHEN** 两个 contributor 返回相同 priority
- **THEN** 二者按注册先后稳定排列,顺序确定可复现

### Requirement: Context 预算裁剪从最旧历史裁

assembler SHALL 估算 `system + messages` 的 context 占用;当超过预算上限时,MUST 从 `history` **最旧端**逐条丢弃直到不超预算或 history 为空(承 §5.4)。当轮用户消息与核心(`tier: 'core'`)注入段 MUST NOT 被裁。预算上限与 token 估算 MUST 外置可配(行为即配置,§3.1),P1 MAY 用字符数 / 近似 token 估算并留 `TokenEstimator` 接缝。

#### Scenario: 超预算裁最旧历史

- **WHEN** 拼装后总占用超过预算上限,且 `history` 含多条消息
- **THEN** 从最旧消息起逐条丢弃,直到占用不超上限;当轮用户消息保留

#### Scenario: 核心段与当轮输入永不裁

- **WHEN** 预算紧张需要裁剪
- **THEN** `tier: 'core'` 注入段与当轮用户消息始终保留,仅裁历史

### Requirement: 两档注入（核心常驻 + 外围召回）

assembler SHALL 区分两档注入(承 §5.4):核心档(`tier: 'core'`,如用户名/过敏、Agent 名/core_belief 等根本设定)MUST 每轮注入且不参与预算裁剪;外围档(`tier: 'peripheral'`,语义/关键词召回)MAY 在预算紧张时随历史裁剪策略外移。内置三段中,人格骨架属核心档,tone 与记忆召回默认外围档。

#### Scenario: 核心档每轮必注入

- **WHEN** 组装任意一轮 prompt
- **THEN** 核心档内容(人格骨架等根本设定)始终出现在 `system` 中

#### Scenario: 外围召回按相关性进出

- **WHEN** 记忆召回命中相关条目
- **THEN** 命中条目以外围档注入;无命中则不注入

### Requirement: KV-cache 稳定性规则

assembler 产出的 `system` 与人格前缀 MUST 在相同人格配置下**字节级稳定**以供 KV-cache 复用(承 §5.4)。volatile 上下文(时间戳 / id 等)MUST NOT 进入 `system`,而是以扁平 `[Context]\n- key: value` bullet **追加到最后一条用户消息**;MUST NOT 使用 `<context>` 等 XML 标签包裹(弱模型会回吐)。

#### Scenario: 稳定前缀供 KV 复用

- **WHEN** 同一人格配置下连续两轮组装
- **THEN** `system` 的人格 / 核心前缀字节级一致,不因时间戳等 volatile 数据变化

#### Scenario: volatile 以扁平 bullet 追加末条用户消息

- **WHEN** 存在 volatile 上下文(如当前时间)
- **THEN** 其以 `[Context]` 扁平 bullet 追加到最后一条用户消息,且不出现 XML 标签

### Requirement: 单 contributor 故障优雅降级

当某 contributor 的 `contribute` 或 `cleanup` 抛错时,assembler MUST 优雅降级:跳过该来源、不计入结果,并记录错误(§8.1),其余 contributor 与整轮组装 MUST NOT 因此中断(§3.2)。组装结束后 assembler MUST 对所有被调用过的 contributor 执行 `cleanup?.()`。

#### Scenario: 单 contributor 抛错跳过不崩

- **WHEN** 某 contributor 的 `contribute` 抛出异常
- **THEN** 该来源被跳过、错误被记录,其余来源照常拼入,回合不中断

#### Scenario: 组装后逐个 cleanup

- **WHEN** 一轮组装完成
- **THEN** assembler 对所有被调用过的 contributor 调用 `cleanup`,清理一次性状态;某 cleanup 抛错不影响其余

### Requirement: 对外等价（重构非破坏）

将现有 `Conversation.#composeSystem` 的三段硬编码拼接(人格骨架 + 记忆召回块 + tone fragment)迁移到 assembler 后,系统 MUST 保持对外等价:给定相同输入(同人格种子、同召回结果、同 tone),新组装的 `system` 段序与内容、`messages` 结构 MUST 与旧实现结构等价;volatile 默认为空时 MUST 字节级等价。本变更 MUST NOT 改动记忆 / 人格的读写路径或持久化 schema。

#### Scenario: 相同输入下结构等价

- **WHEN** 用相同人格种子、相同召回结果、相同 tone fragment 组装一轮
- **THEN** 新 `system` 的段顺序(骨架 → 记忆 → tone)与内容、`messages`(历史 + 当轮用户消息)结构与旧 `#composeSystem` 等价

#### Scenario: volatile 为空时字节等价

- **WHEN** 无 volatile 上下文
- **THEN** 新组装的 `system` 与 `messages` 与旧实现字节级一致

