## 1. 装配层去抖默认(TDD:先测后实现)

- [x] 1.1 在 `packages/client/test/cli-voice-wiring.test.ts` 新增/扩展断言:`loadEchoGuardConfig({})` 返回 `confirmFrames:3`(缺省真去抖);`CHAT_A_ECHO_GUARD=on` 等非关闭值同样 `confirmFrames:3`;`off`/`false`/`0`/`no`/`disabled` 仍返回 `undefined`(开关语义不变)。先写,确认新断言红。
- [x] 1.2 改 `packages/client/src/cli-voice.ts` 的 `loadEchoGuardConfig`:返回 `{ ...DEFAULT_ECHO_GUARD_CONFIG, enabled: true, confirmFrames: 3 }`,并更新该函数中文注释(说明去抖值 3≈30ms、依据、库默认 1 不变的分工)。跑测试转绿。

## 2. 库默认回归硬线(确认不变)

- [x] 2.1 在 `packages/voice-detect/test/echo-guard.test.ts` 补一条聚焦断言:`DEFAULT_ECHO_GUARD_CONFIG.confirmFrames === 1` 且 `enabled === false`(库默认=回归硬线,去抖提升在装配层)。
- [x] 2.2 微调 `packages/voice-detect/src/echo-guard.ts` 注释:在 `DEFAULT_ECHO_GUARD_CONFIG` 与 `confirmFrames` 字段处说明「库默认 1 与装配默认 3 的分工」(值不改)。

## 3. desktop 对齐(核查 + 钉死契约,无需改 desktop 代码)

- [x] 3.1 在 `packages/desktop/test/`(新建或就近已有 main/ipc 测试)加一条测试:desktop `voiceStart` 经共用 `startVoiceMode(deps)`(传 env),缺省下 EchoGuard 被注入(`info.echoGuard === 'on'`);`CHAT_A_ECHO_GUARD=off` 时 `off`。验证 desktop 与 cli 共用装配路径、无漏注入缺口。
- [x] 3.2 确认 desktop 源码无需改动(已核查共用 startVoiceMode);若测试暴露缺口才补,否则记录结论。

## 4. VoiceLoop 去抖时序覆盖(confirmFrames>1)

- [x] 4.1 在 `packages/runtime/test/voice-loop-echo-guard.test.ts` 确认/补齐:注入 `confirmFrames:3` 时,speaking 期连续不足 3 帧高置信不打断(保持 speaking、不 clearBuffer、不写半句),连续 ≥3 帧才打断回 listening。补单帧/断续不打断的边界用例(若现有用例已覆盖则记录,不重复)。

## 5. 收口验证

- [x] 5.1 `pnpm -r typecheck` 全绿。
- [x] 5.2 `npx vitest run packages/voice-detect packages/runtime packages/client packages/desktop` 相关测试绿;最好全量 `npx vitest run` 绿。
- [x] 5.3 `openspec validate barge-in-polish --strict` 通过。
- [x] 5.4 git commit(中文 message,feat(voice): 风格);不 push、不碰 master。
