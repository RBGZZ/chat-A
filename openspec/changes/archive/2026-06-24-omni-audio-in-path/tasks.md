## 1. 失败测试先行(TDD,§3.2 可测试性,不触网)

- [x] 1.1 新建 `packages/runtime/test/voice-loop-omni.test.ts`:加 `fakeOmni(events)` 工厂
      (实现 `OmniAudioPort.respondToAudio`:消费传入音频块,signal 已 abort 则抛 AbortError,
      否则按序 yield 给定 `transcript/text/end` 事件;每次 yield 前查 signal)+ 复用
      voice-loop.test.ts 的 micFrame/driveSpeechThenSilence/flush 风格夹具(Stub VAD/EOU)
- [x] 1.2 用例①直路闭环:fake omni 吐 `[{transcript:'你好小雪'},{text:'你好。'},{text:'很高兴见到你。'},{end}]`,
      voicePath=omni、注入 omni,驱动一回合 → 断言 memory.appendMessage 收 role:'user'/content:'你好小雪'、
      下行有 tts:chunk、BusEvent 含 `stt:final`(text='你好小雪')+`tts:first_audio`+`turn:end`、终态 listening
- [x] 1.3 用例②打断:fake omni 在 `text` 后 await 闸门(模拟回复未完),驱动至 speaking →
      speaking 中再来语音打断 → 断言 omni 回合 signal aborted、半句写回带 `[被用户打断]`、
      回 listening、旧 gen 帧不再下行
- [x] 1.4 用例③降级:(a) fake omni 的 `respondToAudio` 抛错 → 回 listening 不崩;
      (b) voicePath=omni 但 omni=undefined → 走 STT 路径正常闭环(FakeStt 出文本)
- [x] 1.5 用例④默认 STT 回归:不注入 omni / voicePath 缺省 → 闭环与现状一致(确认新增可选字段不污染)
- [x] 1.6 先跑 `npx vitest run`,确认新用例**红**(现状 VoiceLoop 无 omni 分支)

## 2. 实现:VoiceLoop 增可选 omni 直路分支(packages/runtime)

- [x] 2.1 `voice-loop.ts` 加 `VoiceOmniEvent` 类型 + `OmniAudioPort` 接口(runtime 侧最小重声明,
      不反向依赖 providers 具体类);`VoiceLoopDeps` **追加**可选字段 `omni?: OmniAudioPort`
      与 `voicePath?: 'stt' | 'omni'`(缺省 'stt');构造函数读入存私有字段
- [x] 2.2 `#beginThinking` 分流:`omni!==undefined && voicePath==='omni'` → `#startThinkingOmni()`,
      否则 `#startThinking()`(STT 路径**逐字不变**)
- [x] 2.3 新增 `#startThinkingOmni()`:与 `#startThinking` 对称——捕获 gen、清 buf、建本回合
      AbortController(`#currentAbort`)、SentenceSplitter、`enqueueSpeak`/`#speak(_, gen, ac.signal)`;
      `for await` 消费 `omni.respondToAudio(toChunks(buf), {}, ac.signal)`:
      `transcript`(首条)→ 写记忆(role:'user')+ `#go('stt:final',{text})`;
      `text`→ 累积 `#replyAccum` + `splitter.push`→enqueueSpeak;
      `end`/流结束 → flush 尾句 + await speakChain + `#finishTurn(gen)`;
      每迭代查 `gen===#gen`(被打断协作放弃)
- [x] 2.4 omni 回合 catch:`gen===#gen`(真失败)→ warn + `#resetToListening()`;
      `gen!==#gen`(被打断 AbortError)→ 静默忽略(同 STT 路径 .catch);finally 清 `#currentAbort`
- [x] 2.5 确认**复用** `#interrupt`/`#abortCurrent`/`#finishTurn`/`#speak`/`#replyAccum` 半句写回原样,
      不重写打断核心;`stop()` 已 abort 在途回合,omni 回合同样受其覆盖(透传同一 ac.signal)
- [x] 2.6 `voice-turn-state.ts` 加注释:omni 路径复用 `stt:final` 迁移(转写来源不同、语义相同),
      **不新增** VoiceState/VoiceBusEvent
- [x] 2.7 从 `@chat-a/runtime` 导出 `OmniAudioPort` / `VoiceOmniEvent`(供 client 装配引用)

## 3. 实现:装配与配置(packages/client)

- [x] 3.1 cli-voice.ts 加 `loadVoicePath(env): 'stt'|'omni'`(读 `CHAT_A_VOICE_PATH`,缺省/其它=stt;
      沿用 `loadTransportKind` 范式)
- [x] 3.2 cli-voice.ts 加 `createOmniAudioPort(env): OmniAudioPort | undefined`:omni 档构造
      `QwenOmniLlm`(key 读 `CHAT_A_DASHSCOPE_API_KEY`,model 读 `CHAT_A_OMNI_MODEL` 缺省
      `qwen3-omni-flash-realtime`,baseURL 读 `CHAT_A_OMNI_BASE_URL` 缺省 `QWEN_DASHSCOPE_REALTIME_URL`);
      key 缺失或构造抛错 → 打印明确中文提示 + 返回 undefined(回落 STT,绝不崩)
- [x] 3.3 `startVoiceMode`(inprocess 档):`voicePath==='omni'` 时调 `createOmniAudioPort`,把结果
      (可能 undefined)与 voicePath 经 `loopDeps.omni`/`loopDeps.voicePath` 传入 `runVoiceLoop`;
      `info` 增 `path: 'stt'|'omni'`(omni 端口回落时标 'stt')
- [x] 3.4 voice-runner.ts 的 `RunVoiceLoopDeps.loopDeps`(`Omit<VoiceLoopDeps,'transport'|'bus'>`)
      自动带上新可选字段,无需改动结构——确认 `new VoiceLoop({...loopDeps, transport, bus})` 透传 omni
- [x] 3.5 VoiceModeHandle.info 加 `path` 字段;cli.ts 状态行(若打印 info)兼容新字段(不破坏现有展示)

## 4. 验证(必须)

- [x] 4.1 再跑 `npx vitest run`,新 omni 用例转**绿**;既有 `voice-loop.test.ts`/attention/echo-guard/
      preempt 全绿(**默认 STT 路径回归绿**)
- [x] 4.2 worktree 根 `pnpm -r typecheck` 全绿(runtime 新类型 + client 装配;不级联其它包)
- [x] 4.3 自检与 canonical 一致:§4 双路径(omni 优先/STT 兜底)、§7#5 prosody(直听音频)、
      §3.2(降级不崩 + 真打断复用 `#interrupt`);未碰 memory/persona/voice-detect/gateway/autonomy 内部;
      providers `qwen-omni` 只构造不改内部;VoiceLoopDeps 仅追加可选字段
- [x] 4.4 `npx openspec validate omni-audio-in-path --strict` 通过
- [x] 4.5 简报标注**真机/真网络待验**:真 DashScope omni-realtime WS 端到端 + 真麦克风连续对话
      (无 key / headless,本 change 仅 fake omni 桩测)
