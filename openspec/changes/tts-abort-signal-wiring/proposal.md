## Why

barge-in 打断目前**只取消了「想」(LLM 流)**,没取消「说」(TTS 合成)。`VoiceLoop.#speak`
调 `this.#tts.synthesize(sentence)` 时**没传本回合的 `signal`**(voice-loop.ts:383),打断只靠
`#gen++` 让每个已产出的 chunk 自检作废——**底层 `synthesize` 协程仍跑到完**。

- 对 HTTP 桩(FakeTts/当前 kokoro/openai-compat 整段拉取)无功能问题,但**已是真 bug**:打断后
  TTS 仍在后台合成完整句,白烧本地算力 / HTTP 额度。
- 对**即将接入的 Qwen realtime TTS(WebSocket 流式)**会更严重:连接与合成不被真正取消,
  继续烧额度 / 占用连接,违背 §3.2「真打断」与延迟预算。

`TtsProvider.synthesize(text, opts?, signal?)` 接口(providers/src/tts.ts:26)**早已支持
第三参 signal**——缺的只是 `VoiceLoop` 把本回合那个已有的 `AbortController.signal` 接上去。
LLM 侧(conversation.ts / openai-compat-llm.ts)已端到端透传同一类 signal;本 change 把
**同一回合的 signal**也接到 TTS,让 barge-in 真正取消 TTS 合成。

## What Changes

- **`#speak` 接收本回合 signal 并透传**:`#speak(sentence, gen, signal?)` 把 `signal` 传给
  `this.#tts.synthesize(sentence, undefined, signal)`;调用链 `enqueueSpeak` / `onToken` /
  尾句 flush 一并带上本回合 `ac.signal`。打断(`#interrupt`)/停止(`stop`)触发 `ac.abort()` 后,
  进行中的 `synthesize` 收到 `aborted` signal 而真正停止。
- **`#gen` 自检作废保留为双保险**:signal 真取消(底层停产)+ generation 自检(已产出 chunk 不下行)
  叠加,既不浪费尾部算力,也不污染状态。打断后行为(半句写回、回 listening、旧 gen 帧不下行)与现状一致。
- **顺带修复现有 kokoro/openai-compat TTS 打断不真取消的 bug**:它们的 `synthesize` 已能吃 signal,
  此前只因 `VoiceLoop` 不传而失效;本 change 修好这条线。

非破坏性:仅改 `packages/runtime/src/voice-loop.ts`(内部把已有 signal 多传一层)。`VoiceLoopDeps`
公共形状不变,`TtsProvider` 接口不动(已支持 signal),其它包不级联。

## Capabilities

### New Capabilities
<!-- 无 -->

### Modified Capabilities
- `turn-cancellation`: barge-in 打断的取消范围从「仅底层 LLM 流」**扩展到 TTS 合成**——
  `VoiceLoop` 把本回合 `AbortController.signal` 透传给 `tts.synthesize`,打断/停止 `abort()`
  后进行中的 TTS 合成收到 aborted signal 而真停(不再后台跑到完)。

## Impact

- **影响 canonical 章节**:§3.2(真打断 / 优雅降级 / 延迟预算)——打断现在覆盖整条「想→说」链路,
  不再只停 LLM。与权威设计一致,无冲突。
- **代码**:仅 `packages/runtime/src/voice-loop.ts`(`#speak` 签名加 signal、`enqueueSpeak`/
  尾句 flush 透传本回合 `ac.signal`)。
- **测试**:`packages/runtime/test/voice-loop.test.ts` 增「打断时 TTS 收到的 signal 变 aborted」
  用例(注入记录所收 signal 的 fake TTS,触发 barge-in 后断言 `capturedSignal.aborted===true`,
  类比现有 LLM 侧 §195~245 的测法);现有打断/闭环用例随之仍全绿。
- **不涉及**:providers 包(接口已支持,无需改)、client/memory/persona/observability/interaction、
  conversation.ts 等其它 runtime 文件。不引入新依赖、无网络/真模型。
