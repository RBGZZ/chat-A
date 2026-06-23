## 1. 真推理 session 工厂(sherpa-vad-session.ts)

- [x] 1.1 写失败测试(假 sherpa 模块):动态注入一个导出 `infer(Float32Array)->number` 的假模块,断言 `createSherpaVadSession` / `createSherpaEouSession` 返回的端口 `infer` 转调成功、`reset` 安全。
- [x] 1.2 写失败测试:模块装不上(import 抛)→ 抛明确中文错误(含安装提示)。
- [x] 1.3 写失败测试:模块加载但形状不符 → 抛明确中文错误(指明补薄适配)。
- [x] 1.4 最小实现 `sherpa-vad-session.ts`:动态 import(模块名经参数/env/默认)+ 鸭子挑选 `pickProbInferer` + 包成端口 + 明确中文错误。不写 sherpa 进 package.json。
- [x] 1.5 跑绿。

## 2. cli-voice 按 env 选注入 + 回落

- [x] 2.1 写失败测试:`CHAT_A_VAD=silero` + 注入假 sherpa 模块(经 `CHAT_A_SHERPA_MODULE`)→ `info.vad`/`info.eou` 为真。
- [x] 2.2 写失败测试:缺省 → 桩(`info` 标识桩),装配与现状一致。
- [x] 2.3 写失败测试:`CHAT_A_VAD=silero` + sherpa 模块加载失败 → 回落桩、不崩、`info` 标识桩。
- [x] 2.4 最小实现 `createDetectors(env)`:桩/真两路 + 真路径 try/catch 回落桩 + 明确中文提示;`startVoiceMode` 用它并把标识并进 `info`。
- [x] 2.5 `cli.ts` 状态行补打 VAD/EOU 标识。
- [x] 2.6 跑绿。

## 3. 验收

- [x] 3.1 `pnpm -C packages/client typecheck && pnpm -C packages/client test` 全绿。
- [x] 3.2 全仓 `pnpm -r --if-present typecheck` 与 `pnpm test` 全绿、零回归(79 文件 / 855 测试通过)。
- [x] 3.3 `openspec validate voice-real-port-wiring --strict` 通过。
- [x] 3.4 `openspec archive voice-real-port-wiring --yes`。
- [x] 3.5 worktree 分支 `git add -A && git commit`(中文 `feat(client):`),不 push、不切回 master。
