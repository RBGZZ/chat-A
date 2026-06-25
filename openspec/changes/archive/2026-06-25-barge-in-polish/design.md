## Context

barge-in 打断核心已落地且单测覆盖:`packages/runtime/src/voice-loop.ts` 的 `#interrupt`(gen 作废 + `#abortCurrent` 真停 LLM 流 + clearBuffer + 半句写回记忆)、speaking 态检出 VAD `speech_start` 即时打断、AbortSignal 真取消透传 TTS/LLM。EchoGuard 自打断/回声防护(`packages/voice-detect/src/echo-guard.ts` 的 `EchoGuardGate`:N 帧去抖 `confirmFrames` + Tier1 speaking 硬门控 + Tier2 cooldown 冷却窗)也已实现并接入 VoiceLoop(`:291-296`、`:475-543`),装配层 `packages/client/src/cli-voice.ts` 的 `loadEchoGuardConfig`(`:87-93`)已让语音模式**默认开启**(`enabled:true`)。

**问题**:装配默认沿用 `DEFAULT_ECHO_GUARD_CONFIG`,其 `confirmFrames:1`(`echo-guard.ts:91`)等价「首个达标帧即打断」——**没有真正去抖**。真机免提下,自家 TTS 经空气/回环灌进麦克风的单帧回声尖峰、房间瞬态噪声都可能误触 barge-in。这是 §4「自打断防护软件侧部分缓解」的实际空档。

约束:本任务只「打磨」不重写打断核心;走 openspec + TDD + 最小切片;零回归底线(非语音模式 / `CHAT_A_ECHO_GUARD=off` / 既有所有测试仍绿)。不碰 omni / `#startThinkingOmni` / 情感→PAD(并行子代理范围)。

## Goals / Non-Goals

**Goals:**
- 语音模式 EchoGuard 默认真正去抖(连续多帧高置信才打断),压制单帧回声/噪声误打断。
- `CHAT_A_ECHO_GUARD` 开关语义不变,可显式关闭回落现状。
- 核查并钉死 desktop 与 cli 共用 EchoGuard 装配路径(无缺口)。
- 给出 min-interruption 最短打断时长门槛的明确结论与依据。
- 每项 TDD;`pnpm -r typecheck` 全绿;相关测试绿。

**Non-Goals:**
- 不做声学回声消除(AEC,需原生/WebRTC AEC3),留未来/原生。
- 不重写 `#interrupt`/AbortSignal 真停流核心。
- 不新增 `confirmFrames` 专属 env 旋钮(避免过度工程;真机标定后若需再加 `CHAT_A_ECHO_GUARD_CONFIRM_FRAMES`,留后续 change)。
- 不碰 omni 路 / 情感→PAD。

## Decisions

### 决策 1:去抖默认值 = `confirmFrames:3`,且只改装配层(不改库默认)

- **选值依据**:协议帧固定 10ms(`packages/protocol/src/pcm.ts`:`FRAME_MS = 10`,`SAMPLES_PER_FRAME = 160`)。`confirmFrames:3` → 需 ≈30ms 连续高置信语音才确认打断。
  - **下界**:N=1 完全无去抖(现状空档);N=2(≈20ms)能滤掉孤立单帧尖峰但裕度小。选 **N=3** 留一帧裕度,可靠压住「单帧 + 偶发紧邻一帧」的回声/噪声毛刺。
  - **上界**:N 太大(如 ≥10,≈100ms+)会让真人打断明显变迟钝,违「伴侣要能被打断」(§4 核心打断)。30ms 远低于人类反应/语音感知阈,主观上仍是「即时」打断。
  - 故 **3** 是「真去抖 vs 不迟钝」的稳健折中。注意 EchoGuard 在 speaking 路是逐 VAD 帧喂入,且 VAD 自身已有去抖(`speech_start` 经 `VadGate` 确认才触发),3 帧是在 VAD 去抖**之上**的二次确认,针对的正是「VAD 误判一两帧有声」的回声/噪声场景。
- **改装配层不改库默认**:`DEFAULT_ECHO_GUARD_CONFIG.confirmFrames` 保持 `1`。它是 `enabled:false` 配套的「逐字现状」库级安全默认/回归硬线——直接构造或外部注入 Gate(测试、未来其它调用方)时不应擅自改变时序。去抖提升只发生在**语音模式装配层** `loadEchoGuardConfig`(它 `{ ...DEFAULT_ECHO_GUARD_CONFIG, enabled: true, confirmFrames: 3 }`)。这样库默认与装配默认分工清晰、互不耦合,符合「行为即配置」(§3.1)。
- **备选**:(a)直接改 `DEFAULT_ECHO_GUARD_CONFIG.confirmFrames:3` —— 否决:会牵动所有直接用默认配置的路径与既有「N=1 即时确认」语义测试,爆炸半径大且违库默认=回归硬线的定位;(b)加 env 旋钮 —— 否决:本切片过度工程,任务明确「谨慎、最小」。

### 决策 2:desktop 无需改代码,仅补对齐测试

- 核查结论:desktop `voiceStart`(`packages/desktop/src/main.ts:815-838`)经**共用**的 `startVoiceMode(deps)` 启动语音并透传 `env`;`startVoiceMode`(`cli-voice.ts:352`)内部统一调 `loadEchoGuardConfig(env)` 注入 EchoGuard。cli 与 desktop 走**同一条装配路径**,desktop 不存在「漏注入 EchoGuard」缺口,自动继承新去抖默认。
- 故 desktop 侧**不改代码**;补一条 desktop 测试钉死「voiceStart 经 startVoiceMode → EchoGuard 注入(缺省 on)」契约,防未来 desktop 自起 loop 绕开装配导致回归。
- **备选**:在 desktop 单独再调 `loadEchoGuardConfig` —— 否决:重复且会与 `startVoiceMode` 内部注入冲突。

### 决策 3:min-interruption 最短打断时长门槛 —— 不重复加(confirmFrames 已等价覆盖)

- 参考项目(qwen STT 整段无 partial)用「最短打断时长/词数」防一个气音误打断。本项目 `confirmFrames × FRAME_MS` = 最短连续高置信语音时长门槛(N=3 → ≈30ms)。该门槛与 min-interruption 的护栏职责**等价**:都要求「连续达一定时长的真语音才认作打断」。
- 故**不再叠加**独立的最短时长门槛——重复工程、引第二套漂移阈值,违「单一权威」(§3.1)。结论在 spec/design 写明。若未来 N×帧时长不足以覆盖(如帧时长变化),再评估,不在本切片。

## Risks / Trade-offs

- [打断引入 ≈30ms 确认时延] → 这是**有意的去抖代价**,远低于人类感知阈,主观仍「即时」;`CHAT_A_ECHO_GUARD=off` 与非语音模式零影响,可一键回落。
- [既有测试断言「默认 confirmFrames 等价 N=1 即时」可能被新默认打破] → 经核查:`cli-voice-wiring.test.ts` 现仅断言 `enabled`/`info.echoGuard` 不断言 `confirmFrames`,需**新增**断言 `confirmFrames:3`(而非改坏);库默认 `DEFAULT_ECHO_GUARD_CONFIG` 值不变,故 `echo-guard.test.ts`/`voice-loop-echo-guard.test.ts` 中显式传 `confirmFrames` 的用例不受影响。这是任务**有意**的语音模式时序打磨,相关装配测试相应更新而非破坏语义。
- [N=3 是否过严漏掉极短真打断] → 30ms 连续语音对任何真人开口都极易满足(单字发音 ≥100ms),不会漏;真正被滤掉的是 <30ms 的孤立尖峰(回声/噪声),正是目标。
- [desktop 未来自起 loop 绕开 startVoiceMode] → 补对齐测试钉死共用路径契约,回归即红。

## Migration Plan

- 纯行为默认值打磨,无数据/ schema 迁移。
- 回滚:`CHAT_A_ECHO_GUARD=off` 一键回落即时打断;或 revert 本 change 的 `loadEchoGuardConfig` 默认值。
- 灰度:无需;真机标定后若 30ms 仍偏松/偏紧,后续 change 评估加 env 旋钮或调值。

## Open Questions

- 真机标定后 `confirmFrames:3`(≈30ms)是否需微调 / 是否值得加 `CHAT_A_ECHO_GUARD_CONFIRM_FRAMES` env 旋钮——留真机验证后的后续 change,不在本切片。
