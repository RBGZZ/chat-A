## Why

§6.2「用户自定义 Persona 创作」是 P1「用户自治」的落地核心,但当前只做到 env 变量覆盖
`name`/`identity` 和四个情绪旋钮、外加一条 `CHAT_A_USER_PROFILE` 单行画像——**用户没法真正
"造一个角色"**:OCEAN 五维改不了、不能写多段角色背景/故事、画像只能一行、且全靠零散环境变量
(无法手写一个可读可编辑的配置)。canonical §6.2 明确要 **card-as-config(一个可手写的
PersonaCard 文件)+ 角色背景 → 自我 lore 进记忆召回 + 用户画像 → `subject=user` 种子记忆**。
本切片补齐这块,收尾 P1 的「用户自填角色背景/用户画像」缺口。

## What Changes

- **新增 PersonaCard 配置文件(YAML)作为 persona 的权威创作入口**:用户在一个文件里填
  `{name, identity, ocean(五维), dials, greetings, background/lore[], userProfile[]}`;
  由 `CHAT_A_PERSONA_CARD` 指定路径,缺省回落到内置默认种子(等价当前 XIAOXUE,既有行为不破)。
- **角色背景/故事 → 自我 lore 写入记忆**:卡中的 `lore[]`(长背景、故事、设定)在启动时作为
  `subject=agent` 种子记忆写入 `MemoryStore`(ADD+去重幂等),供语义/关键词召回——
  **不塞进静态 system 骨架**(避免 prompt 膨胀,只有 `identity` 进骨架)。
- **用户画像 → `subject=person`(主用户)种子记忆**:卡中的 `userProfile[]` 多条画像/偏好
  逐条写入(去重幂等),冷启动即"已认识你";取代当前单行 `CHAT_A_USER_PROFILE`(保留为兼容)。
- **OCEAN 五维 + greetings 可在卡中整体自定义**:不再受限于只能改 `name`/`identity`/旋钮。
- **env 变量降级为覆盖层**:卡缺省时 env 仍生效(向后兼容);卡存在时 env 可逐字段覆盖卡值
  (行为即配置,§3.2),保证现有冒烟/测试与文档不破。
- **容错降级**:卡文件缺失/解析失败/字段非法 → 落到默认种子 + 告警,绝不硬崩(§3.2)。
- 引入 `yaml` 解析依赖(纯 JS、零传递依赖;YAML 对用户手写多段背景/注释远比 JSON 友好)。

Non-goals(本切片不做):

- **运行时热加载**(canonical §6.2 提及):本切片只在启动时加载一次;loader 做成纯函数
  (path → card)便于后续热加载接入,但热重载触发/事件留到后续切片。
- card 的图形化编辑、§6.3 图片生成画像、§6.4 Live2D、PersonaCard 的 `bindings:{llm,tts,embed}`
  打包(本切片只覆盖人格/记忆字段,provider 绑定仍走现有 env)。
- 语义/向量召回(P2):lore 经现有**关键词**召回即可被命中;向量召回不在本期。

## Capabilities

### New Capabilities
<!-- 无新增独立能力;本切片增强已有 persona-emotion 能力中既有的"用户自定义角色背景与用户画像"需求 -->

### Modified Capabilities
- `persona-emotion`: 强化「用户自定义角色背景与用户画像」需求——授权入口从零散 env 升级为
  **YAML PersonaCard 文件**(env 降为覆盖层);新增 **角色背景/故事 → `subject=agent` 可召回
  自我 lore 记忆**、**多条用户画像 → `subject=person` 种子记忆**、**OCEAN 五维/greetings
  可整体自定义**、**卡解析失败优雅降级到默认种子**。

## Impact

- **延迟预算(§3.2)**:仅启动期一次性加载 + 一次性种子写入(幂等),**回合内零额外延迟**。
- 代码:
  - `@chat-a/persona`:新增 `PersonaCard` 类型 + `loadPersonaCard(path)` 纯函数加载器
    (YAML→PersonaSeed + lore/profile),`config-loader` 改为"卡优先、env 覆盖"。
  - `@chat-a/persona` `package.json`:新增 `yaml` 依赖。
  - `@chat-a/client` `cli.ts`:启动时加载卡 → 装配 seed → 用卡里的 lore/profile 调
    `MemoryStore.addMemory`(替换当前单行 profile 逻辑)。
- 数据:lore/profile 经现有 `addMemory`(`subject`/`personId` 已就位)写入,**无 schema 变更**;
  去重靠现有 `normalized_text UNIQUE`,重复启动幂等。
- 文档:`start.bat`/README 增补 PersonaCard 用法与示例卡;env 变量说明标注"覆盖卡值"。
- 已锁决策不受影响:SQLite 真相源、接缝哲学(loader 只产 seed+输入,不碰 MemoryStore 内部)、
  延迟预算均遵循。
