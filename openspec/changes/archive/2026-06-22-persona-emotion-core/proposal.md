## Why

小雪现在的人格是一段**静态 system prompt**(`XIAOXUE`)——心情不会变,人格也不能由用户调。这违背北极星两点:"有自己的情绪"和"人格由用户自定义(用户自治)"。记忆(跨会话记得)已落地,是"伴侣 not 助手"的第一根支柱;**人格/情感内核是第二根**:让小雪有会演化、可由你定义的心情,语气随心情真实变化(心情差语气会沉)。canonical §6.1/§6.2、§9 P1 明列此块。

## What Changes

- **新增数值人格 + 情感内核**:OCEAN 种子 → PAD 基线(Mehrabian 系数);PAD 作为**状态变量**按弹簧公式回归基线;冷启动前若干轮情绪减半 + 加速回弹。
- **OCEAN/PAD 持久化到 SQLite**:复用 §8.1 真相源(`@chat-a/memory` 的库),心情/人格**跨重启有连续性**;schema 带版本迁移(§3.2)。
- **用户可调旋钮(用户自治落地)**:`personality_dials` + `emotion_dials` 外置为配置,喂 PAD 演化参数(intensity/spring_k)与 tone。
- **情绪 → tone fragment 注入 prompt**:PAD → 最近离散情绪 → 每轮动态 tone fragment(warmth/mood/expressiveness)拼进 system prompt;**旋钮与心情真的改变语气**(payoff)。
- **Appraiser 接缝**:每轮 PAD pull 来自可替换的情绪评估接缝(§3.1);P1 默认实现(确定性启发式)即可让 mood 随对话起伏,LLM 版 OCC→PAD 作为可演进项(默认可关,避免加回合延迟)。
- **用户自填角色背景 + 用户画像(§6.2)**:用户填角色身份/背景/说话风格 → 人格种子(进 system prompt);用户画像 → `subject=user` 种子记忆(写入已落地的 `MemoryStore`)。config 化、可编辑。
- **接线回合**:`Conversation` 每轮:appraise pull → spring step → 持久化 PAD → 渲染 tone fragment 进 system。

## Capabilities

### New Capabilities
- `persona-emotion`: 数值人格(OCEAN)+ 情感状态(PAD)内核——种子→基线、弹簧回归、冷启动、用户旋钮、情绪→tone 注入、Appraiser 接缝、OCEAN/PAD 持久化,以及用户自填角色背景/用户画像。

### Modified Capabilities
<!-- 不改既有 capability 的需求。persona-emotion 会**使用** persistent-memory(写 subject=user 种子记忆),但那是调用其现有能力,不改其 requirements。 -->

## Impact

- **canonical 章节/接缝**:§6.1(数值人格+情绪内核、旋钮、PAD 弹簧、冷启动、tone 注入)、§6.2(用户自填角色/画像)、§3.1(Persona/Appraiser/PersonaStore 接缝)、§3.2(确定性内核 golden test、行为即配置、单一权威公式、迁移纪律、延迟预算)、§5/§8.1(复用 SQLite 真相源)。本次是 §6/§9 P1 的**最小可用子集**,情绪流水线的高级件(二级 OCEAN 演化、自我锚定、夜间沉淀、IPC 全姿态、向量 lore)仍归后续阶段。
- **代码**:新增 `packages/persona`(`@chat-a/persona`):OCEAN/PAD 类型 + 数值内核(确定性)+ `PersonaState`/`Appraiser`/`PersonaStore` 接缝 + tone 渲染 + 配置/种子加载。`packages/cognition` 的静态 `buildSystemPrompt` 改为接收人格种子 + 每轮 tone fragment。`packages/runtime/src/conversation.ts` 接入每轮情绪步进与 tone 注入。`@chat-a/memory` 复用作 PAD/OCEAN 持久化后端(新增持久化接口或新表,design 定)。
- **依赖**:无新外部依赖(数值内核纯 TS;持久化用已装的 `node:sqlite`)。
- **配置**:新增人格/情绪/角色种子的配置项(YAML/env),全外置、可编辑。
- **延迟预算(§3.2)**:PAD 数值步进为**确定性微秒级**,在回合编排层,不进 B 层语音热路径,对首字延迟无影响。Appraiser 默认确定性(零额外延迟);若启用 LLM 版 appraisal,需评估额外一次调用的延迟并默认关闭/可折叠。
- **测试**:确定性内核(OCEAN→PAD、dials→参数、spring 回归、冷启动、PAD→离散情绪、tone 渲染、跨重启状态恢复)写 golden/契约测试。

## Non-goals

- 每 20 轮 OCEAN 二级演化 + delta history 快照(§6.1,后续)。
- 自我一致性锚定 re-anchor(§6.1,依赖向量召回,后续)。
- 夜间沉淀 / dream(§6.1,后续)。
- IPC 完整姿态库(P1 仅最小 mood→tone,不做 SULKING/WITHDRAWN 全套)。
- 自我 lore 向量化语义召回(P2 向量库)。
- PersonaCard 完整打包(P1 仅最小种子/bindings)。
- 图片生成人物画像(§6.3 多模态,P3)。
- Live2D 可视化(§6.4,P3)。
- `interaction_dials` 与 §7 stance 检测深度(无外界交互能力时不做)。
