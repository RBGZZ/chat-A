## Context

动机/需求见 `proposal.md` 与 `specs/persona-emotion/spec.md`。当前人格是 `@chat-a/cognition` 里的静态 `XIAOXUE` system prompt,无状态、不可调。canonical §6.1/§6.2、§9 P1 要求数值人格(OCEAN)+ 情感状态(PAD)+ 旋钮 + 冷启动 + 情绪注入语气 + 用户自填角色/画像。SQLite 真相源(`@chat-a/memory`)与 MemoryStore 接缝已落地,可复用作持久化与用户画像种子。

约束(§3.1/§3.2):确定性内核写 golden test、能算的不交给 LLM;跨模块只依赖接口;行为即配置、单一权威公式、无 magic number;schema 带版本迁移、状态不丢;不进 B 层语音热路径。

## Goals / Non-Goals

**Goals:**
- OCEAN→PAD 基线(Mehrabian)、PAD 弹簧回归、冷启动:确定性纯函数内核 + golden test。
- 用户旋钮(personality/emotion dials)可观测地调制内核与语气。
- 每轮 PAD→离散情绪→tone fragment 注入 system,语气随心情/旋钮真实变化。
- Appraiser 接缝:默认确定性实现可用,LLM 版可选可关。
- OCEAN/PAD 持久化(复用 SQLite 真相源),跨重启续接心情。
- 用户自填角色背景(→人格骨架)+ 用户画像(→`subject=user` 种子记忆)。

**Non-Goals:**（见 proposal Non-goals）二级 OCEAN 演化/delta 快照、自我锚定、夜间沉淀、IPC 全姿态库、向量 lore 召回、PersonaCard 完整打包、图片画像(§6.3)、Live2D(§6.4)、interaction_dials/§7 stance 深度。

## Decisions

### D1. 新增 `@chat-a/persona`,与 cognition 分工
- **`@chat-a/persona`**:纯数值内核(OCEAN/PAD 类型、OCEAN→PAD、dials→参数、spring 步进、冷启动、PAD→离散情绪、tone fragment 渲染)+ 接缝(`Appraiser`、`PersonaStore`)+ 种子类型(`PersonaSeed`)。**无 IO 依赖,可纯单测**。
- **`@chat-a/cognition`**:保留"system 提示组装",`buildSystemPrompt` 改为接收 `PersonaSeed`(身份/背景/说话风格)产出**静态骨架**;依赖 persona 仅取类型。
- **为何独立包**:数值演化人格是清晰、确定性、可重写的内核(与记忆同级),独立包让 runtime/cognition 只依赖接口,爆炸半径可控(§3.1)。

### D2. PAD/OCEAN 持久化 = 复用 `@chat-a/memory` 的 SQLite(通用 KV)
- 在 `@chat-a/memory` 增通用状态 KV:`getState(key): string | undefined` / `setState(key, value)`,落 `kv_state` 表,经 **schema v1→v2 迁移**(IF NOT EXISTS,保留既有数据;复用已建迁移框架)。
- `@chat-a/persona` 定义 `PersonaStore { load(): PersonaSnapshot | null; save(s): void }` + `InMemoryPersonaStore`(默认/测试)。SQLite 版用**结构化 `KvLike = {getState,setState}`** 适配——persona 不直接依赖 memory 包,runtime 把 `mem.store` 当 `KvLike` 注入(JSON 序列化 PersonaSnapshot 存一个 key)。
- **为何 KV 而非 persona 专表**:memory 拥有 DB 连接与迁移;让它提供通用持久化原语、persona 持有语义,避免两个包各开连接、各跑迁移冲突。单一真相源、单一迁移器。

### D3. Appraiser 接缝 + P1 默认实现
- `Appraiser { appraise(ctx: { userText; pad: Pad; turn: number }): PadPull }`,纯函数,上层只依赖接口。
- **P1 默认 = 确定性轻量评估**(小词典/线索→小幅 pull,词典外置为配置)。明确标注为占位,LLM 版 OCC→PAD 作为后续实现(单次轻量 LLM,默认关,启用时计入延迟预算 §3.2)。
- 让"心情随对话起伏"在 P1 即可用,又不引入网络延迟;评估逻辑可整体替换(§3.1)。

### D4. tone 注入(确定性渲染)
- PAD → 最近离散情绪:固定 `PAD→emotion` 表(纯函数)。
- tone fragment = f(离散情绪, emotion_dials.expressiveness/baseline_warmth):短文本(warmth/mood/外显度的行为指令),golden test 锁定。
- 回合 system 组装顺序:**静态骨架(身份+用户角色背景)→ 召回记忆块(已落地)→ 本轮 tone fragment**。fragment 保持短,控 token。

### D5. 每轮流程(runtime 编排)
1. `appraise(userText, pad, turn)` → pull。
2. `step(pad, pull, dials, turn)` → 新 pad(spring + 冷启动 + intensity/volatility 调制),钳制区间。
3. `save(snapshot)`(持久化,回合编排层,非热路径)。
4. `renderTone(pad, dials)` → fragment,拼入 system。
- 交互回合用 `k=0.2`;`k=0.01`(idle)预留给未来 autonomy tick(本次无 idle 来源)。

### D6. 种子与配置(行为即配置)
- `PersonaSeed { ocean, identity/background/speakingStyle 文本, greetings?, dials }` 外置(YAML/env),可编辑;无种子时用与现 `XIAOXUE` 等价的默认,保证既有行为/测试不破。
- 用户画像:`subject=user` 文本经已落地的 `MemoryStore.addMemory` 写入(冷启动"已认识你"或"慢慢了解"由用户选)。
- dials 默认全 0.5/0.6,缺省即中性,无 magic number 散落。

## Risks / Trade-offs

- **P1 默认 appraiser 较粗(词典启发式)→ 心情反应有限** → 接缝可整体换 LLM 版;P1 至少让旋钮/基线/spring 决定的"人格化语气 + 心情连续性"可感。
- **tone fragment + 召回块叠加膨胀 system(token/延迟)** → fragment 渲染保持短;两者都在编排层、非语音热路径。
- **每轮一次 SQLite 写(PAD 持久化)** → 本地同步写、微秒级、回合收尾做,不阻塞流式;与记忆写同批。
- **persona 与 memory 经 `KvLike` 结构耦合** → 仅 `{getState,setState}` 两方法的结构类型,无包级依赖,替换持久化后端不动 persona。
- **OCEAN→PAD/Mehrabian 系数选取** → 采用 canonical 指定的单一权威公式,集中常量、外置可调,杜绝多套漂移。

## Migration Plan

1. 新增 `@chat-a/persona`(纯内核 + 接缝 + 默认实现),不改现有行为。
2. `@chat-a/memory` schema v1→v2 加 `kv_state` + `getState/setState`;迁移保留既有记忆(IF NOT EXISTS + 事务)。
3. `@chat-a/cognition` `buildSystemPrompt` 接收 `PersonaSeed`(默认种子等价当前 XIAOXUE,行为不破)。
4. `Conversation` 接入每轮 D5 流程;默认 `InMemoryPersonaStore` + 默认种子,既有测试不破;配置开启 SQLite 持久化与自定义种子。
5. 回滚:persona 状态/种子是配置项,回退默认种子 + 内存 store 即恢复原静态人格行为;`kv_state` 表独立,不影响记忆。

## Open Questions

- P1 默认 appraiser 取"近中性(几乎不反应,主要靠基线+旋钮)"还是"小词典 valence(轻度反应)"——倾向后者以让 demo 可感,词典外置最小化。
- LLM 版 appraisal 后续是独立轻量调用,还是折叠进主回合的结构化输出(省一次调用但复杂化流式)——留到接 LLM appraiser 时定。
- 离散情绪集合与 `PAD→emotion` 表的粒度(P1 取小集合,足够 tone 区分即可)。
