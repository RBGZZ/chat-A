## MODIFIED Requirements

### Requirement: 用户自定义角色背景与用户画像

系统 SHALL 允许用户通过一个外置 **PersonaCard 配置文件(YAML)**自定义角色与画像,作为用户自治(§6.2)的权威创作入口:角色身份/背景/说话风格(成为人格种子,身份摘要进 system prompt 静态骨架)、OCEAN 五维与情感旋钮、问候语,以及多条用户画像(写入 `subject=person` 主用户的种子记忆,经已落地的 `MemoryStore`)。全部 MUST 可编辑、由配置驱动;卡缺省时 SHALL 回落到内置默认种子(等价既有 XIAOXUE,行为不破)。环境变量(`CHAT_A_PERSONA_NAME`/`CHAT_A_PERSONA_IDENTITY`/旋钮等)SHALL 降为覆盖层:卡存在时按字段覆盖卡值,卡缺省时仍单独生效(向后兼容)。

#### Scenario: 角色身份进入人格骨架

- **WHEN** 卡中提供了角色身份/说话风格
- **THEN** 回合 system 的静态骨架包含该身份描述

#### Scenario: 用户画像成为种子记忆

- **WHEN** 卡中提供了一条或多条用户画像且尚无对应记忆
- **THEN** 每条画像作为 `subject=person`(主用户)记忆被写入存储,后续可被召回

#### Scenario: env 覆盖卡内字段

- **WHEN** 同时存在 PersonaCard 且设置了对应环境变量(如 `CHAT_A_PERSONA_NAME`)
- **THEN** 装配出的种子采用环境变量的值(env 覆盖卡值),其余字段仍取自卡

#### Scenario: 无卡时回落默认并兼容 env

- **WHEN** 未指定 PersonaCard
- **THEN** 装配出等价默认种子;若设置了既有环境变量,则其覆盖默认种子对应字段

## ADDED Requirements

### Requirement: PersonaCard 配置文件加载与容错

系统 SHALL 提供一个 **纯函数加载器**,从 `CHAT_A_PERSONA_CARD` 指定路径读取 YAML PersonaCard,产出人格种子(name/identity/OCEAN 五维/旋钮/greetings)与待种子化的输入(自我 lore 列表、用户画像列表),加载器 MUST 不直接依赖或改写 `MemoryStore` 内部(接缝边界,§3.1)。卡文件缺失、YAML 解析失败或字段类型非法时,加载器 SHALL 优雅降级到默认种子并发出告警,绝不抛出导致进程崩溃(§3.2);非法的单个数值字段(如越界 OCEAN/旋钮)SHALL 回落该字段默认值而非整卡失败。

#### Scenario: 完整卡装配出自定义种子

- **WHEN** 提供了一个含 name/identity/ocean 五维/dials/greetings 的合法 YAML 卡
- **THEN** 加载器返回的人格种子各字段取自卡,且 OCEAN 五维均生效(不再受限于仅 name/identity/旋钮可改)

#### Scenario: 卡文件不存在时降级

- **WHEN** `CHAT_A_PERSONA_CARD` 指向不存在的文件
- **THEN** 加载器返回默认种子并发出告警,不抛异常

#### Scenario: YAML 解析失败时降级

- **WHEN** 卡文件内容不是合法 YAML 或顶层结构非法
- **THEN** 加载器返回默认种子并发出告警,不抛异常

#### Scenario: 单字段非法只回落该字段

- **WHEN** 卡中某 OCEAN 维或旋钮值越界 [0,1]
- **THEN** 该字段回落默认值,卡其余合法字段仍生效

### Requirement: 角色背景/故事作为可召回的自我 lore

系统 SHALL 把 PersonaCard 中的角色背景/故事条目(`lore`)在启动时作为 `subject=agent` 的种子记忆写入 `MemoryStore`(ADD+去重,§5.8),使其能被后续关键词召回参与回合上下文;这些长背景 MUST NOT 整体塞入静态 system 骨架(避免 prompt 膨胀,骨架只含身份摘要 `identity`)。重复启动 SHALL 幂等(依赖既有去重,不产生重复条目)。

#### Scenario: lore 写入为 agent 主语记忆

- **WHEN** 卡中提供了一条或多条 lore 背景
- **THEN** 每条以 `subject=agent` 写入存储,且不出现在静态骨架文本中

#### Scenario: 重复启动幂等

- **WHEN** 以同一张卡重复启动
- **THEN** 既有 lore/画像记忆不被重复新建(命中去重)
