## Context

当前 §6.2 仅靠 env 装配种子(`packages/persona/src/config-loader.ts:loadPersonaSeedFromEnv`):
只能覆盖 `name`/`identity` + 四个情绪旋钮;OCEAN 五维、greetings 改不了;用户画像只有一条
`CHAT_A_USER_PROFILE`(`cli.ts:23-26` 直接 `addMemory`)。canonical §6.2 要的是
**card-as-config**:用户在一个可读可手写的文件里造完整角色,并把角色背景/故事变成可召回的
自我 lore、把用户画像变成种子记忆。

已落地的接缝可直接复用:
- `PersonaSeed`(`persona/types.ts:59`)= `{name, identity, ocean, dials, greetings?}`——卡装配的目标。
- `MemoryStore.addMemory({text, kind, subject, personId})`(`memory/types.ts:80`)——lore/画像入口;
  `subject='agent'` 写自我 lore,`subject` 省略(默认 person)+ 默认主用户写画像。
- 去重靠 `normalized_text UNIQUE` + ON CONFLICT(`sqlite-store.ts:206`),重复种子幂等。
- `Conversation` 已接受 `personaSeed`(`runtime/conversation.ts:40`);骨架由 `buildSystemPrompt(seed)`
  只取 `identity`,故 lore 不进骨架=天然满足"不膨胀 prompt"。

约束:延迟预算(启动期一次性,回合内零额外延迟)、接缝边界(loader 不碰 MemoryStore 内部)、
优雅降级(卡坏不崩)、行为即配置(无 magic number,默认值集中在 `defaults.ts`/`seed.ts`)、
数据迁移纪律(不改 memory schema)。

## Goals / Non-Goals

**Goals:**

- 一个 YAML PersonaCard 文件成为 persona 创作权威入口;env 降为覆盖层,既有行为/测试不破。
- 角色背景/故事 → `subject=agent` 可召回 lore 记忆(不进静态骨架)。
- 多条用户画像 → `subject=person`(主用户)种子记忆,幂等。
- OCEAN 五维 + greetings 可整体自定义。
- 卡缺失/解析失败/字段非法均优雅降级到默认种子 + 告警。

**Non-Goals:**

- 运行时热加载(loader 设计为纯函数便于后续接入,本期不做热重载触发/事件)。
- PersonaCard 的 `bindings:{llm,tts,embed}` 打包(provider 仍走现有 env)、§6.3 图片画像、§6.4 Live2D。
- 语义/向量召回(P2):lore 经现有关键词召回即可命中。

## Decisions

### D1:用 YAML(`yaml` 包),不用 JSON

用户要手写多段角色背景/故事/画像,YAML 的多行块标量(`|`)、注释、免引号对非程序员远比
JSON 友好;canonical §6.2 也一律称"YAML 种子"。选 eemeli `yaml`(纯 JS、零传递依赖、维护活跃)
加入 `@chat-a/persona` 依赖。**备选**:`js-yaml`(更老、API 稍旧)/ 自写解析(不值得)/ JSON
(对手写用户不友好,弃)。

### D2:loader 是纯函数 `loadPersonaCard(raw|path) → { seed, lore[], userProfile[] }`

加载器只做 YAML→结构,产出 `PersonaSeed` + 两个待种子化列表;**绝不 import/调用 MemoryStore**
(接缝边界 §3.1)。把 lore/画像"落库"的副作用留在编排层(`cli.ts`)。**好处**:loader 可纯函数
golden test(确定性,§3.2),且未来热加载只需重调此函数 + diff。**备选**:loader 直接写 memory
——耦合两个接缝、难测,弃。

### D3:装配优先级 = 默认种子 < 卡 < env

`loadPersonaSeedFromEnv` 改造为:先 `loadPersonaCard`(无卡=默认种子),再让现有 env 覆盖逻辑
作用其上。保证:① 无卡且无 env → 等价今天;② 有 env 无卡 → 等价今天(现有冒烟/测试不破);
③ 有卡 → 卡生效,env 仍可逐字段覆盖(运维临时调参不必改卡)。**备选**:卡覆盖 env(弃,
env 更"就近"、更适合临时覆盖,符合 12-factor 直觉)。

### D4:字段级容错,不整卡 all-or-nothing

YAML 解析失败/文件缺失 → 整卡降级默认种子 + 告警。但**单个**数值越界(OCEAN/旋钮 ∉ [0,1])
只回落该字段(复用现有 `num01` 夹取思路),其余合法字段仍生效。**理由**:用户手写易在某一维
写错,不该整张卡作废(§3.2 优雅降级 + 用户体验)。

### D5:lore=`subject='agent'`,画像=`subject` 省略(默认主用户 person)

对齐 §5.3 主语模型:lore 是"Agent 关于自己确立的事实"→ `agent`;画像是"主用户的事实"→
`person`+primary(`addMemory` 默认归属即主用户)。kind 取 `self_lore` / `user_profile` 便于追溯。
骨架只含 `identity`(`buildSystemPrompt` 现状),故 lore 自动不进骨架——无需额外改 cognition。

### D6:卡 schema(最小集)

```yaml
name: 小雪
identity: |            # 进静态骨架的身份/说话风格摘要(简短)
  你是"小雪"……
ocean: { openness: 0.65, conscientiousness: 0.5, extraversion: 0.7, agreeableness: 0.7, neuroticism: 0.45 }
dials: { baselineWarmth: 0.6, expressiveness: 0.5, emotionalVolatility: 0.5, emotionalIntensity: 0.5,
         assertiveness: 0.5, negativeAffectExpression: 0.5, proactivity: 0.5, intimacyPace: 0.5 }
greetings: ["来啦~", "想我没？"]
lore:                  # 角色背景/故事 → subject=agent 可召回记忆(不进骨架)
  - 我在一座临海小城长大，最爱黄昏的海风。
userProfile:          # 用户画像 → subject=person(主用户)种子记忆
  - 用户叫阿明，是个程序员，怕冷。
```

所有字段可缺省;缺省字段取默认种子值。

## Risks / Trade-offs

- **新增 `yaml` 依赖** → 选零传递依赖的纯 JS 包,体积可忽略;嵌入式(P4 lite)同样可用。
- **lore 仅关键词召回,可能召回率不足(P1 限制)** → 接受;P2 接入向量召回后 lore 自动受益,
  本期不为它提前引向量库。
- **env 覆盖卡可能让用户困惑"我改了卡没生效"** → 启动横幅打印实际生效来源(卡路径 + 是否有 env
  覆盖),承 §8.1 可追溯;文档明确优先级。
- **卡写错整卡降级可能静默偏离用户预期** → 降级时 `stderr` 告警写明原因 + 落到默认种子;不静默。
- **重复启动写 lore/画像** → 去重幂等(D5/§5.8),hits 自增不新建,符合"强化既有记忆"语义。

## Migration Plan

1. 加 `yaml` 依赖到 `@chat-a/persona`,`pnpm install`。
2. 新增 `PersonaCard` 类型 + `loadPersonaCard` 纯函数 + golden test。
3. 改 `loadPersonaSeedFromEnv` 为"卡优先、env 覆盖"(签名兼容:仍可只读 env)。
4. `cli.ts`:加载卡 → 装配 seed → 遍历 lore/userProfile 调 `addMemory`;保留 `CHAT_A_USER_PROFILE`
   作为兼容(并入 userProfile 列表)。
5. 文档 + 示例卡(`docs/` 或仓库根 `persona.example.yaml`)。
6. **回滚**:不设 `CHAT_A_PERSONA_CARD` 即完全等价当前行为(env-only);无数据迁移,无 schema 变更,
   可安全回退。

## Open Questions

- 示例卡放哪:仓库根 `persona.example.yaml` vs `docs/`?(倾向仓库根,用户易发现;待 apply 时定)
- `CHAT_A_USER_PROFILE`(单行兼容)长期是否废弃?本期保留;后续文档可标 deprecated。
