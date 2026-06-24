## Why

权威设计 §4 把「**自打断防护**」明确列为缺口(行 162、行 176、§9 行 572):

- 行 176:「**AEC 或 agent 说话时门控 STT**(防自打断,树莓派关键)」。
- 行 162:「**EchoGuard 必须真启用 + barge-in 连续 N 帧去抖**」。
- §9 行 572 待办:「🆕 自打断防护方案(§4):AEC vs『agent 说话时门控 STT』二选一/并用」。

现状:`VoiceLoop` 在 `speaking`(自己正在出声)期间,只要 VAD 检出一次 `speech_start`(默认 2 帧去抖)就**立即**打断自己(`voice-loop.ts:343-350` 未注入关注闸的路径)。在**没有硬件 AEC** 的半双工裸 WebSocket 链路上(尤其树莓派外放 + 麦克风同设备),小雪自己的 TTS 经空气/回环被麦克风收到,极易被 VAD 误判成「用户在说话」,从而**自打断**——刚开口就把自己掐断,对话无法进行。

真正的回声消除(AEC)是**声学/原生**问题,不在本 change 范围(见 design.md「边界声明」)。本 change 做**软件侧的部分缓解**:在 `VoiceLoop` 处于 `speaking` 时,对 barge-in 施加**更严格的连续 N 帧高置信语音确认**(EchoGuard),压制自家 TTS 回声引起的误打断;**非说话期保持原灵敏度**,且真人连续说话仍能可靠打断——绝不变成「打不断」。

## What Changes

- **`@chat-a/voice-detect` 新增纯函数去抖 helper** `echo-guard.ts`:`EchoGuardConfig` 配置类型 + `DEFAULT_ECHO_GUARD_CONFIG`(安全默认)+ `EchoGuardGate` 类(确定性、无副作用、无时钟)。Gate 在 `speaking` 期累计「连续高置信语音帧数」,达到 `confirmFrames`(N)且(可选)能量达标才确认为真打断;期间一旦掉到静音即清零重计。**默认 N=1**——使既有单帧/双帧 barge-in 时序逐字不变(回归硬线)。
- **`VoiceLoop` 内置 EchoGuard**(`packages/runtime/src/voice-loop.ts`),经**构造可选项** `echoGuard?: EchoGuardConfig` 控制:
  - **未注入(缺省)**:行为逐字不变(等价默认 N=1,即时打断),既有 barge-in 测试全绿。
  - **注入**:`speaking` 期检出语音不再立即打断,而是喂 `EchoGuardGate`;连续 N 帧高置信(且可选能量阈值)才 `#interrupt()`;掉到静音即清零。`listening/endpointing` 期**不经** EchoGuard,灵敏度不变。
  - 与既有**关注闸(attention,§7 软反转)**正交叠加:EchoGuard 先做「这是不是真语音(非回声)」的去抖确认,确认后再(若注入 attention)按 `attention_mode` 判是否真打断。两者都不注入则等价现状。
  - **危机/硬打断豁免**:经 attention 的 `buildSignal` 标注 `hardInterrupt`/`crisis` 时,EchoGuard MUST 让路(立即打断),不被 N 帧去抖拖延(承「救命不可配」)。
- **行为即配置**:N 帧阈值、是否启用、可选能量阈值全走 `EchoGuardConfig`,给安全默认;无 magic number。

### Non-goals

- **不做真正的回声消除(AEC)**——那需声学/原生方案(自适应滤波、参考信号对消),留作未来/原生。本 change 仅软件侧部分缓解。
- **不改 client / cli-voice**(另一并行 agent 地盘):EchoGuard 安全默认(未注入即现状),cli 无需改即可正常运行。
- 不动 `packages/autonomy` / `providers` / `memory` / `protocol`。
- 不引入新的跨模块依赖;不接真模型/不触网。

### 对延迟预算的影响(§3.2)

零额外阻塞:EchoGuard 是 `speaking` 期上行音频回调里的**同步纯计数**(O(1)/帧),不引入 await、不阻塞首字/首音延迟。代价是**说话期打断确认延迟 ≈ (N-1)×帧时长**(N=3、10ms/帧 → 约 20ms),远小于人对打断的感知阈值,且只在说话期生效;`listening`/`endpointing` 灵敏度与现状完全一致。

## Capabilities

### New Capabilities
- `echo-guard`: VoiceLoop 自打断防护(软件侧部分缓解)契约——`speaking` 期 barge-in 连续 N 帧高置信去抖、可选能量阈值、危机/硬打断豁免、安全默认(未注入即现状)、非说话期灵敏度不变、纯函数 Gate 可确定性测试。

## Impact

- **代码**:`packages/voice-detect/src/echo-guard.ts`(新增纯函数 Gate + config)+ `packages/voice-detect/src/index.ts`(导出)+ `packages/runtime/src/voice-loop.ts`(内置 EchoGuard,构造可选项)+ 二者 `test/`(确定性单测)。
- **依赖**:CI 依赖图不变(无新外部包、不触网)。
- **接缝**:`VoiceLoop` 只经类型 import `@chat-a/voice-detect` 的 `EchoGuardGate`/`EchoGuardConfig`(§3.1 接缝);不反向依赖、不串层。
- **回归硬线**:默认 N=1 使既有 `voice-loop.test.ts` barge-in 用例时序逐字不变;`pnpm -r typecheck` + `npx vitest run` 全绿(新增 + 回归)。
- **canonical 章节**:§4(行 162/176 自打断防护)、§9(行 572 待办);与权威设计一致,补其明确缺口。完整 AEC 仍标记为未来/原生。
