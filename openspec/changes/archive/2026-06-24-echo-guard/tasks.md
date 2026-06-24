# Tasks: echo-guard

## 1. EchoGuard 纯函数去抖件(@chat-a/voice-detect)

- [x] 1.1 新增 `packages/voice-detect/src/echo-guard.ts`:`EchoGuardConfig` 类型 + `DEFAULT_ECHO_GUARD_CONFIG`(`enabled:false`/`confirmFrames:1`/`minSpeechProb:0.5`/`minEnergy:0`)+ `EchoGuardGate` 类(`push({prob,energy01,speakingFromVad}) → {confirmed,run}` + `reset()`,纯计数无时钟无副作用)。中文注释,无 magic number。
- [x] 1.2 `packages/voice-detect/src/index.ts` 导出 `echo-guard`。
- [x] 1.3 新增 `packages/voice-detect/test/echo-guard.test.ts`:禁用即时确认 / N=1 首帧确认 / N=3 连续三帧(中途清零重计)/ 能量阈值过滤低能量帧。

## 2. VoiceLoop 内置 EchoGuard(@chat-a/runtime)

- [x] 2.1 `voice-loop.ts`:`VoiceLoopDeps` 新增可选 `echoGuard?: EchoGuardConfig`;构造时若注入则 `new EchoGuardGate(cfg)` 存 `#echoGuard`,否则 `undefined`。type-only import 自 `@chat-a/voice-detect`。
- [x] 2.2 `#onAudio` 的 `speaking` 分支:**未注入**(`#echoGuard===undefined`)走现状逐字不变路径;**注入**则先算该帧归一能量(RMS/fullScale)喂 `#echoGuard.push(...)`,`confirmed` 后才进入既有两路打断(未注入 attention→即时 `#interrupt`;注入 attention→`#applyAttention`)。未确认保持 speaking。
- [x] 2.3 危机/硬打断豁免:注入 attention 且 `buildSignal` 信号带 `crisis`/`hardInterrupt` 时,绕过 EchoGuard 直接打断。
- [x] 2.4 在进/出 speaking(`#interrupt` / `#finishTurn` / `#resetToListening`)处 `#echoGuard?.reset()` 清连续计数。
- [x] 2.5 新增 `packages/runtime/test/voice-loop-echo-guard.test.ts`:说话期回声样式被压制 / 真人连续 N 帧仍能打断(clearBuffer + 半句写回)/ 非说话期灵敏度不变 / 危机豁免单帧即打断。

## 3. 回归 + 验收

- [x] 3.1 既有 `packages/runtime/test/voice-loop.test.ts` 不改且全绿(未注入 EchoGuard 即默认现状)。
- [x] 3.2 `pnpm -r typecheck` 全绿。
- [x] 3.3 `npx vitest run` 全绿(新增 + 回归,强调既有 barge-in 用例绿)。
- [x] 3.4 `npx openspec validate echo-guard --strict` 通过。
