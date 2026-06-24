## MODIFIED Requirements

### Requirement: VoiceLoop barge-in 触发底层 LLM 真取消

`VoiceLoop` SHALL 为每个「想」回合创建一个 `AbortController`,并把其 `signal` 传入注入的
`send(text, onToken, signal)`。注入的 `send` 签名 SHALL 扩展为
`(text, onToken, signal?) => Promise<string>`(`signal` 可选、向后兼容,`onToken` 流式不变)。
确认打断时(`#interrupt`,barge_in_pending→listening),`VoiceLoop` MUST 调用该 `AbortController`
的 `abort()`,使底层 LLM 流真正停止;`stop()` 作废在途回合时亦 MUST `abort()`。被打断的回合的
半句写回与 generation 作废逻辑 MUST 与现状一致(abort 导致 send reject 时不重复 reset 状态)。

此外,`VoiceLoop` MUST 把**同一回合的 `AbortController.signal`**也透传给 TTS 合成:对该回合的每一句
合成,MUST 调用 `tts.synthesize(sentence, opts?, signal)`,使打断/停止 `abort()` 后**进行中的 TTS
合成**收到 aborted signal 而真正停止(不再后台跑到完、不继续烧本地算力或远端额度;对 WebSocket realtime
TTS 尤为关键)。`signal` 缺省(undefined)时,`synthesize` 调用形状与行为 MUST 与现状等价(向后兼容)。
基于 generation 令牌的「已产出 chunk 不再下行」自检 MUST 保留为**双保险**(signal 真停底层产出 +
generation 作废已产出输出),二者叠加不冲突。

#### Scenario: 打断时调用 abort 真停 LLM

- **WHEN** VoiceLoop 处于 speaking、用户插嘴触发 barge-in 打断
- **THEN** 本回合的 `AbortController.abort()` 被调用,注入 send 收到的 signal 变为 aborted

#### Scenario: 打断时 TTS 合成收到 aborted signal 真停

- **WHEN** VoiceLoop 处于 speaking(本回合已向 `tts.synthesize` 传入回合 signal)、用户插嘴触发 barge-in 打断
- **THEN** 传给本回合 `tts.synthesize` 的 signal 变为 aborted,进行中的 TTS 合成据此停止(不再后台合成完整句)

#### Scenario: TTS 与 LLM 共用同一回合 signal

- **WHEN** 同一「想」回合内既调用了注入的 `send` 又调用了 `tts.synthesize`
- **THEN** 两者收到的是同一个 `AbortController` 的 signal,一次 `abort()` 同时取消 LLM 流与 TTS 合成

#### Scenario: 缺省 signal 时 TTS 调用等价

- **WHEN** 注入的 TTS 实现不依赖 signal(或回合未发生打断)
- **THEN** `tts.synthesize` 的调用形状与产出行为与本切片之前一致(纯加法、向后兼容)

#### Scenario: abort 后半句写回与回 listening 不变

- **WHEN** 打断发生且本回合已累积半句回复
- **THEN** 半句仍按现状写回记忆(带 `[被用户打断]`)、状态回 listening、旧 gen 帧不再下行,与现状一致
