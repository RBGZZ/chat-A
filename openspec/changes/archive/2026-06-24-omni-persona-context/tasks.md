# Tasks

## 1. VoiceLoop 接缝(runtime)
- [x] 1.1 `OmniAudioPort` 的 opts 由 `Record<string, never>` 放宽为新增 `OmniAudioOpts { instructions? }`(纯加法,与 `QwenOmniLlm.OmniAudioOptions` 兼容)。
- [x] 1.2 `VoiceLoopDeps` 增可选 `composeOmniInstructions?: () => string | Promise<string>`;构造期存为私有字段(未注入=undefined)。
- [x] 1.3 `#startThinkingOmni`:在 `respondToAudio` 前 `await #composeOmniInstructionsSafe()`,非空则以 `{ instructions }` 传入,否则空 opts。
- [x] 1.4 `#composeOmniInstructionsSafe()`:未注入→undefined;注入则 try/catch await,抛错/超时/空串→undefined(warn,不崩不阻塞)。

## 2. Conversation 只读复用(runtime)
- [x] 2.1 `Conversation` 新增 `composeOmniInstructions(): Promise<string>`:复用 `#deps` + `mood` + `detectStance` + `composeSystem`,取 `assembled.system`;userText='',不要 messages。
- [x] 2.2 内部任何步骤失败 → 兜底返回 persona 骨架(`#deps.skeleton`),绝不空、不抛。

## 3. 装配层注入(client)
- [x] 3.1 `cli-voice` 的 `VoiceModeDeps` 增可选 `composeOmniInstructions?`;`startVoiceMode` 透传进 `loopDeps`(仅在提供时填)。
- [x] 3.2 `cli.ts` 语音模式以 `() => convo.composeOmniInstructions()` 注入(与 STT 路同源 persona/memory/tone)。

## 4. 测试(不触网)
- [x] 4.1 注入 fake omni(记录收到的 `opts.instructions`)+ fake `composeOmniInstructions` → 验证 omni 回合把组装的 instructions 传进 `respondToAudio`。
- [x] 4.2 `composeOmniInstructions` 抛错 → 验证退回空 opts、omni 回合仍正常完成、回 listening、不崩。
- [x] 4.3 未注入 `composeOmniInstructions` → 验证 omni 回合传空 opts(与本变更前一致)。
- [x] 4.4 STT 路径回归:既有 VoiceLoop / Conversation 测试全绿(STT 路不受影响)。
- [x] 4.5 `Conversation.composeOmniInstructions` 单测:返回含人设骨架的 system;内部 compose 抛错时兜底返回骨架。

## 5. 验收
- [x] 5.1 `pnpm -r typecheck` 全绿。
- [x] 5.2 `npx vitest run` 全绿(新增 + STT 路回归)。
- [x] 5.3 `openspec validate omni-persona-context --strict` 通过。
