## 1. 失败测试先行(TDD,§3.2 可测试性)

- [x] 1.1 在 `packages/runtime/test/voice-loop.test.ts` 增用例:注入一个**记录所收 signal**的
      fake TtsProvider(其 `synthesize(text, opts?, signal?)` 捕获 `signal` 并监听 `abort`,
      每 chunk 前自检 `signal?.aborted` 干净结束),驱动至 speaking、触发 barge-in 打断,
      断言 `capturedTtsSignal instanceof AbortSignal`、打断前 `aborted===false`、
      打断后 `capturedTtsSignal.aborted===true`(类比 LLM 侧 §195~245 测法)
- [x] 1.2 同测确认与 send 侧拿到的是**同一回合 signal**(可断言两者为同一 AbortSignal 实例,
      或各自都在打断后 aborted),证明 TTS 与 LLM 共用本回合 `ac.signal`
- [x] 1.3 先跑 `npx vitest run`,确认新用例**红**(现状 `#speak` 不传 signal → 捕获到 undefined / 未 aborted)

## 2. 实现:把本回合 signal 透传给 TTS 合成(仅改 voice-loop.ts)

- [x] 2.1 `#speak` 签名加可选第三参 `signal?: AbortSignal`,把 `this.#tts.synthesize(sentence)`
      改为 `this.#tts.synthesize(sentence, undefined, signal)`;更新方法 JSDoc 点明真取消
- [x] 2.2 `#startThinking` 里 `enqueueSpeak` 闭包透传本回合 `ac.signal`:
      `speakChain = speakChain.then(() => this.#speak(sentence, gen, ac.signal))`
      (`onToken` 凑句与 send 完成后的尾句 flush 共用同一 `enqueueSpeak`,故一处改即覆盖全部喂句)
- [x] 2.3 保留 `#speak` 内每 chunk 的 `gen === #gen` 自检作为双保险(signal 真停 + gen 作废叠加);
      catch 仍吞 TTS 抛错跳过本句(abort 可能令 synthesize 以 AbortError 抛,属正常取消)

## 3. 验证(必须)

- [x] 3.1 再跑 `npx vitest run`,新用例转**绿**,现有打断/闭环/降级用例全绿
- [x] 3.2 worktree 根 `pnpm -r typecheck` 全绿(仅内部多传一层 signal,不级联其它包)
- [x] 3.3 自检与 canonical §3.2 一致:打断现在覆盖「想→说」整链;仅改 voice-loop.ts 未越界碰
      providers/client/memory/persona/conversation.ts;未引新依赖/网络/真模型
