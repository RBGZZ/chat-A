## ADDED Requirements

### Requirement: 关系亲密度 closeness 调制 tone(单向 → 表达)

tone 渲染 SHALL 可接受**关系亲密度** `closeness`(承 §6.1b / §2.4)并据其调制语气的**温暖度、自我披露深度、称呼亲昵度**。closeness MUST 按外置的三档阈值(`midLow`/`midHigh`，无散落 magic number)落档：

- **亲近档**(高于 `midHigh`)：语气更暖、更愿意主动分享自己的事和感受、可用更亲昵的称呼。
- **疏远档**(低于 `midLow`)：语气礼貌而克制、少做自我披露、保持适当距离。
- **适中档**(两阈值之间)：不追加关系语气行(关系不显著，省 token)。

closeness MUST **单向影响表达**，绝不反改 OCEAN/PAD 或情绪(关系只调语气，不污染人格/情绪状态)。`closeness` 参数 MUST 可选：**省略时 tone 输出 MUST 逐字等于未引入 closeness 前的旧行为**(向后兼容)；透传 MUST 满足 exactOptional 安全(仅在提供时附带实参，绝不显式传 undefined)。落档 MUST 确定性(同一 closeness 恒落同档)。

#### Scenario: 高 closeness 注入更暖/愿分享的语气

- **WHEN** 以高于 `midHigh` 的 closeness 渲染 tone
- **THEN** tone 文本含亲近档指令(更暖、愿分享、更亲昵称呼)

#### Scenario: 低 closeness 注入克制/少披露的语气

- **WHEN** 以低于 `midLow` 的 closeness 渲染 tone
- **THEN** tone 文本含疏远档指令(礼貌克制、少自我披露)，且与高 closeness 的输出不同

#### Scenario: 适中档不追加关系语气行

- **WHEN** 以介于两阈值之间的 closeness 渲染 tone
- **THEN** 不追加任何【关系】语气行

#### Scenario: 省略 closeness 逐字等于旧行为

- **WHEN** 渲染 tone 时不传 closeness(或传 undefined)
- **THEN** 输出与未引入 closeness 前逐字一致，不追加任何关系行

#### Scenario: closeness 不反改人格与情绪

- **WHEN** 以任意 closeness 渲染 tone
- **THEN** OCEAN/PAD 与离散情绪不因 closeness 改变(closeness 仅单向调语气)
