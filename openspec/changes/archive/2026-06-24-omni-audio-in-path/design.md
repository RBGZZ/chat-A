# 设计:omni audio-in 直路(path B)接进 VoiceLoop

## 0. 背景与硬约束

- 权威:canonical §4(双路径)、§7#5(从语音读情绪 prosody)、§3.2(优雅降级 / 真打断)。
- provider 侧 path B 接缝形状来自 archive `2026-06-24-qwen-omni-realtime-llm/design.md §3.3`。
- **默认 STT 路径行为逐字不变**:omni 是可选加法;不注入 omni 端口 / 配置不开 = 现状。

## 1. omni 端口接缝(VoiceLoopDeps 追加可选字段)

只追加,不重排。在 runtime 侧自定义一个**最小**音频面端口类型(不反向依赖 providers
的具体类),与 `QwenOmniLlm.respondToAudio` 形态等价:

```ts
/** omni 事件(与 providers OmniEvent 等价;runtime 侧最小重声明,避免反向依赖具体 provider 类)。 */
export type VoiceOmniEvent =
  | { readonly type: 'transcript'; readonly text: string }
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'end' };

/** audio-in 直路端口(path B):吃 PCM 块流,yield transcript/text/end。 */
export interface OmniAudioPort {
  respondToAudio(
    audio: AsyncIterable<PcmChunk>,
    opts?: Record<string, never>,
    signal?: AbortSignal,
  ): AsyncIterable<VoiceOmniEvent>;
}

export interface VoiceLoopDeps {
  // ……既有字段不动……
  /** 可选 audio-in 直路端口(path B,§4 双路径)。注入 + `CHAT_A_VOICE_PATH=omni` 才走;
   *  未注入 = 纯走现有 STT→LLM 路径(零改、逐字不变)。失败 → 降级回 STT(§3.2)。 */
  readonly omni?: OmniAudioPort;
}
```

`QwenOmniLlm` 的实际签名是 `respondToAudio(audio, opts?: OmniAudioOptions, signal?)`;
其 `OmniAudioOptions` 字段全可选,故 `QwenOmniLlm` 结构上**满足** `OmniAudioPort`(传 `{}`
作 opts 合法)。装配层直接把 `QwenOmniLlm` 实例当 `omni` 注入即可,无需适配层。

## 2. VoiceLoop 状态机:omni 直路如何复用现有迁移

关键洞察:**omni 直路无独立 STT step,但状态迁移完全复用现状**——只是「转写从哪来」变了。

| 阶段 | STT 路径(现状) | omni 直路(本 change) |
|------|----------------|----------------------|
| 攒音频 | listening→endpointing(VAD speech_start) | 同左,**不变** |
| 判说完 | endpointing,TurnDetector 静音判 EOU | 同左,**不变** |
| 取转写 | `#transcribe(buf)` 喂 STT 取 final 文本 | 喂 `omni.respondToAudio(buf)`,取 `transcript` 事件文本 |
| 进 thinking | `#go('stt:final', {text})` | **同事件** `#go('stt:final', {text: transcriptText})` |
| 出回复 | `send(text, onToken, signal)` 流式 token | omni 流式 `text` 事件当 token |
| 分句→说 | SentenceSplitter + `#speak` | **复用** SentenceSplitter + `#speak` |
| 收尾 | send resolve → `#finishTurn` | omni `end` 事件 → `#finishTurn` |
| 打断 | `#interrupt`(gen++/abort/clearBuffer/半句写回) | **复用 `#interrupt` 原样** |

**结论:不新增 VoiceState / VoiceBusEvent。** `voice-turn-state.ts` 仅加注释说明 omni 路径
复用 `stt:final` 迁移(转写来源不同,迁移语义相同)。

### 2.1 实现落点:`#beginThinking` 分流

现状 `#beginThinking` → `void this.#startThinking()`(STT 路径)。改为:

```
#beginThinking():
  if (this.#omni !== undefined && this.#voicePath === 'omni')
    void this.#startThinkingOmni();   // 新增:omni 直路
  else
    void this.#startThinking();        // 现状:STT 路径(逐字不变)
```

`#startThinkingOmni` 与 `#startThinking` 结构对称(共享 gen 捕获、AbortController、
SentenceSplitter、`enqueueSpeak`/`#speak`、`#finishTurn`、半句写回),差异仅在「转写/回复
增量来源」:

```
#startThinkingOmni():
  gen = ++#gen
  buf = #audioBuf; #audioBuf = []
  ac = new AbortController(); #currentAbort = ac
  splitter = new SentenceSplitter()
  speakChain = resolve()
  enqueueSpeak(s) = speakChain.then(() => #speak(s, gen, ac.signal))   // 与 STT 路径同
  #replyAccum = ''
  let sawTranscript = false
  #currentTurn = (async () => {
    try {
      for await (ev of #omni.respondToAudio(toChunks(buf), {}, ac.signal)):
        if (gen !== #gen) return                      // 被打断/换回合:协作放弃
        switch ev.type:
          'transcript':
            text = ev.text.trim()
            if (text && !sawTranscript):
              sawTranscript = true
              // endpointing→thinking,emit stt:final 携真转写(供 trace/可追溯一致)
              if (#state === 'endpointing') #go('stt:final', { text })
              // 写记忆:用户话语(等价 STT 文本,供记忆/召回)
              #memory.appendMessage({sessionId, turnId:'omni', role:'user', content:text, createdAtMs:now()})
          'text':
            #replyAccum += ev.text
            for sentence of splitter.push(ev.text): enqueueSpeak(sentence)
          'end':
            tail = splitter.flush(); if (tail) enqueueSpeak(tail)
      // 流自然结束(可能未显式 end):flush 尾句、等说完、收尾
      if (gen === #gen):
        tail = splitter.flush(); if (tail) enqueueSpeak(tail)
        await speakChain
        #finishTurn(gen)
    } catch (err) {
      // omni 失败(连接/鉴权/WS 意外关闭/抛错):仅当仍是本回合才降级(§3.2)
      if (gen === #gen):
        console.warn('[VoiceLoop] omni 直路失败(降级回 listening):', err)
        #resetToListening()
      // gen 已变(被打断,signal abort 致 AbortError reject):静默忽略,同 STT 路径 .catch
    } finally {
      if (#currentAbort === ac) #currentAbort = null
    }
  })()
```

要点:
- **打断**:`#interrupt` 原样复用——`#gen++` + `#abortCurrent()`(abort 本回合 ac →
  `respondToAudio` 的 signal aborted → WS 真停)+ clearBuffer + 半句写回 + 回 listening。
  omni 的 `respondToAudio` 已实现 signal abort 关 WS(provider change 已测),此处只透传。
- **半句写回**:打断时 `#replyAccum`(已累积的 `text` 增量)经现有 `#interrupt` 写回,
  与 STT 路径**完全一致**(共用同一字段与逻辑)。
- **generation 自检**:`for await` 每次迭代查 `gen === #gen`;`#speak` 内每 chunk 自检——
  与 STT 路径双保险一致。
- **`#finishTurn` 复用**:omni `end`(或流自然结束)后 flush 尾句、await speakChain、收尾。

### 2.2 降级语义(§3.2)

| 失败点 | 处理 |
|--------|------|
| `omni` 端口未注入 / 配置非 omni | 走 STT 路径(`#startThinking`),零行为变化 |
| 装配期 omni 构造失败 / key 缺失 | cli-voice 打印中文提示,**不注入 omni**(`omni=undefined`)→ 全程 STT 路径 |
| `respondToAudio` 首次迭代前/中抛错(连接/鉴权/WS 意外关闭) | catch → `#resetToListening()` 干净回 listening,不崩,记 warn |
| 本回合已被打断(gen 变,AbortError) | 静默忽略,不重复 reset(同 STT 路径 .catch) |

> 注:本 change 的降级是「本回合干净结束 / 不崩 + 默认路径不受影响」。更强的「omni 失败后
> 该回合即时切 STT 重跑」涉及把已攒 buf 二次喂 STT 的复杂度与 buf 生命周期管理,留后续/
> 网关层路由(canonical §4 故障链)。当前优先保证**默认 STT 路径零回归** + **omni 失败不崩**。

## 3. 装配与配置(client)

- `loadVoicePath(env): 'stt' | 'omni'` —— 读 `CHAT_A_VOICE_PATH`,缺省/其它一律 `'stt'`
  (缺省零行为变更,沿用 `loadTransportKind` 范式)。
- `createOmniAudioPort(env): OmniAudioPort | undefined` —— omni 档构造 `QwenOmniLlm`:
  - key 读 `CHAT_A_DASHSCOPE_API_KEY`;缺失 → 打印中文提示,返回 `undefined`(回落 STT)。
  - model 读 `CHAT_A_OMNI_MODEL`(缺省 `qwen3-omni-flash-realtime`);baseURL 读
    `CHAT_A_OMNI_BASE_URL`(缺省 `QWEN_DASHSCOPE_REALTIME_URL`)。
  - instructions 暂不接(可后续从人格 prompt 注入;本 change 不接,保持最小)。
  - 构造抛错 → catch、打印中文提示、返回 `undefined`(回落 STT,绝不崩)。
- `startVoiceMode` 仅 `voicePath==='omni'` 时调 `createOmniAudioPort`,把结果(可能 undefined)
  注入 `loopDeps.omni`,并把 `voicePath` 传给 VoiceLoop(决定 `#beginThinking` 分流;若
  omni 端口为 undefined 则 VoiceLoop 内部即便 voicePath=omni 也走 STT,双保险)。
- websocket 传输档下 omni 走大脑侧,本 change inprocess 档接;info 增 `path: 'stt'|'omni'`。

## 4. 测试策略(不触网)

新文件 `packages/runtime/test/voice-loop-omni.test.ts`,fake omni:

```ts
function fakeOmni(events, opts?): OmniAudioPort {
  return { async *respondToAudio(audio, _o, signal) {
    for await (const _ of audio) { /* 消费音频(模拟送出);可记录块数 */ }
    if (signal?.aborted) throw new DOMException('aborted','AbortError');
    for (const ev of events) {
      if (signal?.aborted) throw new DOMException('aborted','AbortError');
      yield ev;
    }
  }};
}
```

用例:
1. **直路闭环**:fake omni 吐 `[{transcript:'你好小雪'},{text:'你好。'},{text:'很高兴见到你。'},{end}]`
   → 断言:memory.appendMessage 收到 role:'user' content:'你好小雪';下行收到 tts:chunk;
   BusEvent 序列含 `stt:final`(text='你好小雪')、`tts:first_audio`、`turn:end`;终态 listening。
2. **打断**:omni 回合卡在一个闸门(text 后 await gate),speaking 中再来语音 → 断言
   signal aborted、半句写回带 `[被用户打断]`、回 listening、旧帧不再下行。
3. **降级回 STT 行为**:① fake omni 的 `respondToAudio` 抛错 → 回 listening 不崩;
   ② **omni 端口未注入**(voicePath=omni 但 omni=undefined)→ 走 STT 路径正常闭环。
4. **默认 STT 回归**:不注入 omni(或 voicePath 缺省)→ 既有闭环逐字绿(既有 voice-loop.test.ts
   本就覆盖,不动它;此处补一条确认 omni 字段缺省不影响)。

## 5. 一致性自检

- §4 双路径:omni 优先(配置开 + 端口在),失败/未配 → STT 兜底。✅
- §7#5 prosody:omni 直接听原始音频,语气/情绪进模型,不经 STT 丢失。✅
- §3.2:优雅降级(失败不崩、回 STT)+ 真打断(signal abort 关 WS,复用 `#interrupt`)。✅
- 模块化/爆炸半径:omni 仅在 VoiceLoop 加一个对称分支 + client 装配;providers/voice-detect/
  memory/persona/autonomy 内部不碰;VoiceLoopDeps 只追加可选字段。✅
- 行为即配置:`CHAT_A_VOICE_PATH` / `CHAT_A_OMNI_MODEL` / `CHAT_A_OMNI_BASE_URL` 外置,无 magic。✅
