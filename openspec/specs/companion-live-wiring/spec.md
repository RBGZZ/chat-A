# companion-live-wiring Specification

## Purpose
TBD - created by archiving change companion-live-wiring. Update Purpose after archive.
## Requirements
### Requirement: 「填 key 即用」默认 LLM provider 解析(纯加法分支)

`loadLlmConfig` SHALL 在 `CHAT_A_LLM_PROVIDER` **未显式设置**时按如下优先级解析默认 provider(承 §3.2 行为即配置 / 填 key 即用):若 `CHAT_A_DASHSCOPE_API_KEY` 存在且非空 → 默认 `qwen`(`model` 缺省 `qwen-plus`),apiKey 在 `CHAT_A_LLM_API_KEY` 缺省时回落到该 DashScope key;否则保持现有优先级(有 `ANTHROPIC_API_KEY` → `anthropic`,再 → `fake`)。**显式设置** `CHAT_A_LLM_PROVIDER` 时 MUST 完全沿用显式值(本分支 MUST NOT 介入);`CHAT_A_LLM_MODEL` / `CHAT_A_LLM_API_KEY` 显式给出时 MUST 优先于本分支的默认。本分支 MUST 为纯加法,不改变任何既有分支的现有行为。

#### Scenario: 仅填 DashScope key 即默认 qwen

- **WHEN** `CHAT_A_LLM_PROVIDER` 未设、`ANTHROPIC_API_KEY` 未设,仅设 `CHAT_A_DASHSCOPE_API_KEY=sk-x`,调用 `loadLlmConfig`
- **THEN** 返回 `provider='qwen'`、`model='qwen-plus'`、`apiKey='sk-x'`

#### Scenario: DashScope key 优先级高于 fake、低于显式 provider

- **WHEN** `CHAT_A_LLM_PROVIDER` 未设、`ANTHROPIC_API_KEY` 未设、`CHAT_A_DASHSCOPE_API_KEY` 未设,调用 `loadLlmConfig`
- **THEN** 返回 `provider='fake'`(现有回落不变)
- **WHEN** 显式设 `CHAT_A_LLM_PROVIDER=anthropic` 且 设 `CHAT_A_DASHSCOPE_API_KEY=sk-x`
- **THEN** 返回 `provider='anthropic'`(显式优先,DashScope 分支不介入)

#### Scenario: Anthropic key 现有默认行为不变

- **WHEN** `CHAT_A_LLM_PROVIDER` 未设、`CHAT_A_DASHSCOPE_API_KEY` 未设、设 `ANTHROPIC_API_KEY=sk-a`,调用 `loadLlmConfig`
- **THEN** 返回 `provider='anthropic'`、`model='claude-opus-4-8'`、`apiKey='sk-a'`(逐字不变)

#### Scenario: 显式 model / api key 覆盖默认

- **WHEN** `CHAT_A_LLM_PROVIDER` 未设、仅 `CHAT_A_DASHSCOPE_API_KEY=sk-x`,且显式 `CHAT_A_LLM_MODEL=qwen-max`、`CHAT_A_LLM_API_KEY=sk-generic`
- **THEN** 返回 `provider='qwen'`、`model='qwen-max'`、`apiKey='sk-generic'`(显式优先于本分支默认)

### Requirement: memory → autonomy 端口适配器(装配层,默认随 autonomy 关)

系统 SHALL 在装配层(`packages/client/src/assembly/`)提供把 `@chat-a/memory` 适配成 autonomy `OpenThreadPort` / `PresencePort` 的实现,且 MUST 只经各包**既有公开 API**实现(承 §3.1 依赖倒置:不 import memory/autonomy 内部)。`OpenThreadPort.listOpenThreads()` SHALL 基于 `store.openThreads()` 把每条 `MemoryRecord` 映射成 `OpenThread`(`id` 转字符串、`text` 作 `topic`、`personId` 透传、`lastSeenAtMs` 作 `lastMentionedAtMs`;memory 无 `dueAtMs`/`personName` 数据时 MUST 省略这两个可选位)。`PresencePort` 因 memory 无直接「用户上次活跃」数据,SHALL 实现成**最小可用**:维护进程内 `lastUserActiveAtMs`(由总线用户事件刷新,无事件时回落构造时刻),`currentEpisodeId()` 据 idle 切片轮转(同一段连续空闲内稳定)。适配器读取失败 MUST 优雅降级(返回空列表 / 安全缺省,不抛,§3.2)。该适配器 MUST 仅在 `CHAT_A_AUTONOMY=on` 时构造;off 时 MUST NOT 构造。

#### Scenario: open-thread 适配把记忆映射成候选话题

- **WHEN** 假 store 的 `openThreads()` 返回若干 `MemoryRecord`(含 id/text/personId/lastSeenAtMs),经适配器调 `listOpenThreads()`
- **THEN** 返回等量 `OpenThread`,各字段按 `id→String(id)` / `text→topic` / `personId` / `lastSeenAtMs→lastMentionedAtMs` 映射;未提供 `dueAtMs`/`personName`

#### Scenario: presence 适配在无活跃事件时回落构造时刻

- **WHEN** 构造 presence 适配器后未喂任何用户活跃事件,读 `lastUserActiveAtMs()`
- **THEN** 返回构造时刻(或注入时钟的「现在」),不抛;`currentEpisodeId()` 返回稳定字符串

#### Scenario: 适配器读取失败优雅降级

- **WHEN** 假 store 的 `openThreads()` 抛错,经适配器调 `listOpenThreads()`
- **THEN** 返回空数组,不抛(候选回路不中断)

### Requirement: autonomy 真候选源接入(文字 + 语音两路,默认关)

系统 SHALL 在文字(`cli.ts`)与语音两条 autonomy 装配处,当 `CHAT_A_AUTONOMY=on` 时注入 `combinedCandidateSource([openThreadCandidateSource(openThreadAdapter, clock), idleArcCandidateSource(presenceAdapter, clock)])` 作为 `assembleAutonomy` 的 `candidateSource`,使主动回合用**真实候选**(未了话题跟进 / idle 想念弧)替代 signal 占位喂决策 LLM(承 §7)。候选 MUST 只作喂料——决策 LLM 的 schema 约束 / 概率闸 / 失败退 silent / 落 trace 行为 MUST 逐字不变(restraint-first 不被候选数量削弱)。`CHAT_A_AUTONOMY` 未设或非 `on` 时 MUST NOT 构造候选源、MUST NOT 构造适配器——既有路径逐字不变。

#### Scenario: 开启时真候选源产出未了话题候选并喂决策

- **WHEN** `CHAT_A_AUTONOMY=on`,以 FakeLlm(speak)+ 假 store(含未了话题)+ 注入候选源装配 autonomy,经总线驱动一次主动 tick
- **THEN** 主动回合的候选来自真候选源(未了话题渲染文本),决策落注入 sink(decision=speak)

#### Scenario: 候选源单源抛错被隔离

- **WHEN** combined 候选源中某一子源 gather 抛错
- **THEN** 该源被跳过、其它源候选仍产出,决策回路不中断(§3.2)

#### Scenario: 关闭时不构造候选源

- **WHEN** `CHAT_A_AUTONOMY` 未设或非 `on`,运行文字 / 语音装配
- **THEN** 不构造候选源、不构造 memory 适配器、不装配 autonomy;既有文字/语音链路逐字不变

### Requirement: 语音模式接 VoiceLoop is_speaking 真闸与抢占(默认关)

系统 SHALL 在语音模式拿到 `VoiceLoop` 实例处,当 `CHAT_A_AUTONOMY=on` 时装配 autonomy 并注入 `voiceState: () => loop.speakState()` 与 `preempt: (reason) => loop.requestAutonomyPreempt(reason)`(承 §7)。注入后 arbiter MUST 经 `voiceState` 查 VoiceLoop **真实忙闲**(而非保守缺省 `{isSpeaking:false}`);`shouldPreempt` MUST 经 `preempt` 触发 VoiceLoop 真打断。装配层 MUST 只**读取** `VoiceLoop` 已暴露的 `speakState()` / `requestAutonomyPreempt()`,MUST NOT 修改 `voice-loop.ts`、MUST NOT 重写其内部抢占约束——**用户语音 URGENT 永远最高、autonomy 抢占绝不凌驾用户**的约束沿用 `VoiceLoop` 内既有实现。`CHAT_A_AUTONOMY` 未设或非 `on` 时 MUST NOT 装配 autonomy、MUST NOT 注入 voiceState/preempt;语音链路逐字不变。

#### Scenario: 开启时 arbiter 查到 VoiceLoop 真在说话则不抢话

- **WHEN** `CHAT_A_AUTONOMY=on`,语音模式装配 autonomy 注入 `voiceState`(假 VoiceLoop 状态报 `isSpeaking:true`),驱动一次主动 speak 决策仲裁
- **THEN** arbiter 据 `voiceState` 查到正在说话,出声被相应抑制 / 排队(而非按缺省「未在说」直接放行)

#### Scenario: 开启时 shouldPreempt 经 preempt 触发真打断

- **WHEN** `CHAT_A_AUTONOMY=on`,注入 `preempt`,主动回合 `shouldPreempt` 为真
- **THEN** 调用注入的 `preempt(reason)`(即 `loop.requestAutonomyPreempt`),不直接 import / 改 VoiceLoop 内部

#### Scenario: 关闭时语音模式不装配 autonomy

- **WHEN** `CHAT_A_AUTONOMY` 未设或非 `on`,启动语音模式
- **THEN** 不装配 autonomy、不读 `speakState`、不调 `requestAutonomyPreempt`;既有语音「听→想→说」逐字不变

