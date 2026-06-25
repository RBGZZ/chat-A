## Why

barge-in 打断核心(`VoiceLoop.#interrupt` + AbortSignal 真停流 + EchoGuard 自打断防护)已落地且单测覆盖,语音模式也已默认开启 EchoGuard。但**装配层 EchoGuard 的 `confirmFrames` 默认值为 1**(`loadEchoGuardConfig` 沿用 `DEFAULT_ECHO_GUARD_CONFIG`),N=1 等价「首个达标帧即打断」——**没有真正去抖**,自家 TTS 经空气/回环灌进麦克风的单帧回声尖峰、房间瞬态噪声都可能误触 barge-in。这是真机免提场景误打断防护的实际空档(§4 自打断防护「软件侧部分缓解」未真正生效)。本次为 P0 打磨:让默认 N 真正去抖,使真机更稳,不重写打断核心。

## What Changes

- **语音模式 EchoGuard 默认 `confirmFrames` 从 1 调到 3**(仅装配层 `loadEchoGuardConfig`):需连续 3 帧(≈30ms,10ms/帧)高置信语音才确认是用户真说话→才打断,压制单帧回声/噪声尖峰误打断;30ms 远低于人类反应/感知阈,伴侣仍「能被打断」(不变迟钝)。
- **`CHAT_A_ECHO_GUARD` 开关语义不变**:`off`/`false`/`0`/`no`/`disabled` 仍显式关闭(回落逐字现状即时打断);其余/缺省仍默认开。本切片不新增 env 旋钮(避免过度工程;真机标定后若需再加 `CHAT_A_ECHO_GUARD_CONFIRM_FRAMES`,留后续 change)。
- **`DEFAULT_ECHO_GUARD_CONFIG.confirmFrames` 保持 1 不变**(库级安全默认/回归硬线):它是 `enabled:false` 配套的「逐字现状」默认,直接注入(测试/外部调用)时不应改变时序;去抖的提升只发生在**语音模式装配层**。
- **desktop 对齐核查(确认无缺口)**:desktop `voiceStart` 经共用的 `startVoiceMode(deps)`(传 `env`),`startVoiceMode` 内部统一调 `loadEchoGuardConfig(env)` 注入 EchoGuard——cli 与 desktop **共用同一装配路径**,desktop 不存在「漏注入 EchoGuard」缺口,自动继承新默认。补一条 desktop 侧测试钉死此契约,防回归。
- **min-interruption 最短打断时长门槛结论(不重复加)**:qwen STT 整段无 partial,参考项目用「最短打断时长/词数」防一个气音误打断。本项目 `confirmFrames × 10ms` 帧时长 = 最短连续语音时长门槛(N=3 → ≈30ms 连续高置信),**已等价覆盖**该护栏职责;再叠一个独立时长门槛是重复工程,故**不加**,仅在 design 写明结论与依据。

## Capabilities

### New Capabilities
<!-- 无新增能力;纯打磨既有 EchoGuard / 语音装配行为。 -->

### Modified Capabilities
- `voice-mode-wiring`: 语音模式装配的 EchoGuard 默认 `confirmFrames` 由「沿用库默认 1」改为「3(真去抖)」;新增/明确「语音模式默认开启 EchoGuard 且默认值为去抖值」的装配契约(此前仅存在于代码、未入主 spec)。
- `voice-detection`: 明确 `DEFAULT_ECHO_GUARD_CONFIG.confirmFrames` 保持 1 的依据(库级回归硬线;去抖提升在装配层),requirement 文字补注「装配层去抖默认与库默认的分工」。

## Impact

- **代码**:`packages/client/src/cli-voice.ts`(`loadEchoGuardConfig` 默认 `confirmFrames:3`);`packages/desktop` 无需改代码(共用 `startVoiceMode`),仅补对齐测试。`packages/voice-detect/src/echo-guard.ts` 注释微调(说明分工),`DEFAULT_ECHO_GUARD_CONFIG` 值不变。
- **测试**:`packages/client/test/cli-voice-wiring.test.ts`(断言默认 `confirmFrames:3`);`packages/desktop/test/*`(钉死 desktop 经 startVoiceMode 注入 EchoGuard);`packages/voice-detect/test/echo-guard.test.ts`(confirmFrames>1 去抖行为已有,补一条聚焦默认值语义);`packages/runtime/test/voice-loop-echo-guard.test.ts`(confirmFrames>1 时连续帧才打断/单帧不打断,部分已覆盖,补齐边界)。
- **canonical 章节**:§4(自打断防护软件侧缓解)、§3.2(优雅降级——env 关仍回落现状)、§3.1(行为即配置——阈值外置、无 magic number)。
- **延迟预算(§3.2)**:打断从「单帧即触发」改为「连续 3 帧(≈30ms)确认」,引入 ≈30ms barge-in 确认时延——这是**有意的去抖代价**,远低于感知阈,换取真机不误打断;非语音模式、`CHAT_A_ECHO_GUARD=off` 零影响。
- **Non-goals**:不做声学回声消除(AEC,需原生/WebRTC AEC3,留未来);不重写 `#interrupt`/AbortSignal 真停流核心;不碰 omni / `#startThinkingOmni` / 情感→PAD(并行子代理范围);不新增 env 旋钮。
