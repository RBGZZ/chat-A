# VoiceLoop v1 端到端语音回合骨架 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 InProcess + Fake 把"听→想(Conversation.send)→说"串成 CI 可测的可取消语音回合 `VoiceLoop`(半双工、单一四态、核心打断 + 半句写回)。

**Architecture:** `VoiceLoop`(runtime 薄外壳)消费 AudioTransport 上行音频帧 → voice-detect VAD/EOU 判回合 → FakeStt 转写 → `send(text, onToken)` → onToken 经 SentenceSplitter 凑句 → FakeTts → 下行音频帧;一轮 = 一个 generation;打断 = gen 自检作废 + clearBuffer + 半句写回记忆。

**Tech Stack:** TypeScript(strict + exactOptionalPropertyTypes)、ESM、pnpm workspaces、Vitest。

## Global Constraints
- TS strict + **exactOptionalPropertyTypes**:可选字段绝不显式 `undefined`,条件展开/省略。
- 注释中文;每包 `pnpm -F @chat-a/<pkg> typecheck`;测试走根 vitest(`npx vitest run packages/<pkg>`)或包内 `test` 脚本。
- **零改** `conversation.ts`/`turn-shared.ts`/`tool-calling-strategy.ts` 主体(VoiceLoop 只经 `send: (text,onToken)=>Promise<string>` 函数消费)。
- 确定性测试:Fake/InProcess + 注入时钟/概率,**不依赖真实时间/随机/真引擎/真音频**。
- 已就位接口(勿改签名,实现时读真文件对齐):
  - `AudioTransport { sendAudio(f:AudioFrame):void; onAudio(l):Unsubscribe; close():void }`;`AudioFrame = Extract<Frame,{type:'audio:input'|'tts:chunk'}>`(`protocol/audio-transport.ts`+`frames.ts`)。
  - voice-detect:`VadDetector { pushFrame(f:PcmFrame):VadFrameResult; reset() }`、`StubVadDetector(probs, cfg)`;`VadFrameResult` 带可选 `event:{type:'speech_start'|'speech_end'}`。`TurnDetector { step(input:TurnStepInput):EndpointingDecision; reset() }`、`StubEouModel(probs)`;`EndpointingDecision` 带 `shouldEndpoint:boolean` + `state:TurnState`。
  - providers:`SttProvider.transcribe(audio:AsyncIterable<PcmChunk>,opts?,signal?):AsyncIterable<SttResult>`(`SttResult{text,isFinal,language?}`)、`FakeStt`;`TtsProvider.synthesize(text,opts?,signal?):AsyncIterable<PcmChunk>`、`FakeTts`;`PcmChunk{samples,sampleRate,channels}`。
  - `Conversation.send(userText, onToken:(t:string)=>void):Promise<string>`。

---

## 执行结构(并行 / 串行)
- **并行**:Task 1(protocol `clearBuffer`)、Task 2(runtime `sentence-splitter.ts`)、Task 3(runtime `voice-turn-state.ts`)。三者互不依赖、不同文件(Task 2/3 同包不同文件、均**不改 index.ts**)。
- **串行**:Task 4(runtime `voice-loop.ts` + index.ts 导出三者),消费 Task 1/2/3 + 既有积木。

---

## Task 1: protocol — AudioTransport.clearBuffer()（可并行）

**Files:**
- Modify: `packages/protocol/src/audio-transport.ts`(接口加方法 + InProcess 实现)
- Test: `packages/protocol/test/audio-transport.test.ts`(加用例)

**Interfaces:**
- Produces: `AudioTransport.clearBuffer(): void` —— 排空"已下发未投递"的输出音频(打断时用)。InProcess 默认同步投递无队列 → `clearBuffer` 清掉 `async` 模式下已 `queueMicrotask` 但未触发的待投递帧;并暴露一个可被测试/Fake 播放端观察的"已清空"语义。`close()` 后 no-op。

- [ ] **Step 1: 写失败测试**。在 `packages/protocol/test/audio-transport.test.ts` 加:

```ts
it('clearBuffer 丢弃 async 模式下未投递的帧', async () => {
  const t = new InProcessAudioTransport({ async: true });
  const got: AudioFrame[] = [];
  t.onAudio((f) => got.push(f));
  t.sendAudio(ttsFrame(1));   // 排进微任务,未投递
  t.clearBuffer();            // 应丢弃
  await Promise.resolve();    // 放行微任务
  expect(got).toHaveLength(0);
});
it('clearBuffer 同步模式 + close 后均不抛(幂等)', () => {
  const t = new InProcessAudioTransport();
  expect(() => t.clearBuffer()).not.toThrow();
  t.close();
  expect(() => t.clearBuffer()).not.toThrow();
});
```
> `ttsFrame(seq)` 用文件内既有构造 `tts:chunk` 帧的 helper;若无则内联一个最小合法 `tts:chunk` AudioFrame(带 TTS_AUDIO_FORMAT + Int16Array 样本 + seq)。

- [ ] **Step 2: 运行确认失败**。`npx vitest run packages/protocol -t clearBuffer`,Expected: FAIL(`clearBuffer is not a function`)。
- [ ] **Step 3: 实现**。`AudioTransport` 接口加 `clearBuffer(): void`(中文注释:打断时排空已下发未投递的输出音频;§4.2.2 不设常驻队列,仅清 async 待投递)。`InProcessAudioTransport`:把 async 投递从"裸 `queueMicrotask`"改为带一个**单调代际/待投递标志**——记一个 `#pendingEpoch`,`clearBuffer()` 时 `#pendingEpoch++` 使已排程的微任务回调启动时自检 epoch 不符即跳过投递;`close()`/同步模式下 `clearBuffer` 为安全 no-op。保持现有同步路径不变。
```ts
// sendAudio async 分支改为:
const epoch = this.pendingEpoch;
queueMicrotask(() => {
  if (this.closed || epoch !== this.pendingEpoch) return; // 被 clearBuffer/close 作废
  for (const l of targets) this.deliver(l, frame);
});
// 新增:
clearBuffer(): void {
  if (this.closed) return;
  this.pendingEpoch++; // 作废所有已排程未投递的微任务
}
```
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/protocol typecheck && npx vitest run packages/protocol`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/audio-transport.ts packages/protocol/test/audio-transport.test.ts
git commit -m "feat(protocol): AudioTransport.clearBuffer 打断排空已下发未投递音频(VoiceLoop v1)"
```

---

## Task 2: runtime — sentence-splitter.ts（可并行,搬 voice-core）

**Files:**
- Create: `packages/runtime/src/sentence-splitter.ts`
- Test: `packages/runtime/test/sentence-splitter.test.ts`

**Interfaces:**
- Produces: `class SentenceSplitter { push(text: string): string[]; flush(): string | null }` —— 流式喂入 token 文本,`push` 返回**本次新凑成的完整句**(可 0..n 句),残余留缓冲;`flush` 在流结束时吐出残余(无残余返回 null)。CJK 友好(中英文标点 `。！？.!?\n` 切),`maxChars` 上限(默认 120)防 TTS 超长,标点不足时按 `，；,;` fallback 切;构造可配 `{ maxChars?, minChars? }`。

- [ ] **Step 1: 写失败测试**。`packages/runtime/test/sentence-splitter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { SentenceSplitter } from '../src/sentence-splitter';

describe('runtime/SentenceSplitter', () => {
  it('中英文标点切句,残余留缓冲', () => {
    const s = new SentenceSplitter();
    expect(s.push('你好。今天')).toEqual(['你好。']);
    expect(s.push('天气不错!')).toEqual(['今天天气不错!']);
    expect(s.flush()).toBeNull();
  });
  it('flush 吐残余', () => {
    const s = new SentenceSplitter();
    s.push('没有结束标点');
    expect(s.flush()).toBe('没有结束标点');
  });
  it('maxChars 超长强制切(防 TTS 溢出)', () => {
    const s = new SentenceSplitter({ maxChars: 5 });
    const out = s.push('一二三四五六七');
    expect(out[0]!.length).toBeLessThanOrEqual(5);
  });
});
```

- [ ] **Step 2: 运行确认失败**。`pnpm -F @chat-a/runtime test sentence-splitter`,Expected: FAIL。
- [ ] **Step 3: 实现**。`SentenceSplitter`:内部 `#buf` 累积;`push` 扫描句末标点 `。！？!?\n` 切出完整句;超 `maxChars` 无标点则在 `maxChars` 处(优先就近 `，；,; ` 否则硬切)切;`flush` 返回 `#buf`(trim 后非空则返回并清空,否则 null)。无 magic number,标点集与上限做常量/构造参数。
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test sentence-splitter`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/sentence-splitter.ts packages/runtime/test/sentence-splitter.test.ts
git commit -m "feat(runtime): SentenceSplitter 流式句级切分(CJK+maxChars+fallback,搬 voice-core)"
```

---

## Task 3: runtime — voice-turn-state.ts（可并行）

**Files:**
- Create: `packages/runtime/src/voice-turn-state.ts`
- Test: `packages/runtime/test/voice-turn-state.test.ts`

**Interfaces:**
- Produces:
  - `type VoiceState = 'listening' | 'endpointing' | 'thinking' | 'speaking' | 'barge_in_pending'`
  - `type VoiceBusEvent = 'vad:speech_start' | 'vad:speech_end' | 'stt:final' | 'tts:first_audio' | 'turn:end' | 'turn:interrupt'`
  - `const VOICE_TRANSITIONS: Record<VoiceState, Partial<Record<VoiceBusEvent, VoiceState>>>` —— 合法迁移表(见 spec §2)。
  - `function nextState(from: VoiceState, event: VoiceBusEvent): VoiceState | null` —— 合法则返回目标态,非法返回 null(调用方据此 warn 不抛)。

- [ ] **Step 1: 写失败测试**。`packages/runtime/test/voice-turn-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { nextState } from '../src/voice-turn-state';

describe('runtime/voice-turn-state', () => {
  it('完整闭环合法迁移', () => {
    expect(nextState('listening', 'vad:speech_start')).toBe('endpointing');
    expect(nextState('endpointing', 'stt:final')).toBe('thinking');
    expect(nextState('thinking', 'tts:first_audio')).toBe('speaking');
    expect(nextState('speaking', 'turn:end')).toBe('listening');
  });
  it('打断迁移', () => {
    expect(nextState('speaking', 'vad:speech_start')).toBe('barge_in_pending');
    expect(nextState('barge_in_pending', 'turn:interrupt')).toBe('listening');
  });
  it('非法迁移返回 null', () => {
    expect(nextState('listening', 'tts:first_audio')).toBeNull();
  });
});
```

- [ ] **Step 2: 运行确认失败**。`pnpm -F @chat-a/runtime test voice-turn-state`,Expected: FAIL。
- [ ] **Step 3: 实现**。按 spec §2 迁移表写 `VOICE_TRANSITIONS`(listening→endpointing[vad:speech_start];endpointing→thinking[stt:final]、→listening[vad:speech_end];thinking→speaking[tts:first_audio];speaking→listening[turn:end]、→barge_in_pending[vad:speech_start];barge_in_pending→listening[turn:interrupt]);`nextState` 查表返回或 null。
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test voice-turn-state`,Expected: PASS。
- [ ] **Step 5: Commit**

```bash
git add packages/runtime/src/voice-turn-state.ts packages/runtime/test/voice-turn-state.test.ts
git commit -m "feat(runtime): VoiceState 四态+瞬态迁移表(迁移=§4.2.1 BusEvents)"
```

---

## Task 4: runtime — voice-loop.ts（串行,消费 Task 1/2/3 + 既有积木）

**Files:**
- Create: `packages/runtime/src/voice-loop.ts`
- Modify: `packages/runtime/src/index.ts`(导出 voice-loop / sentence-splitter / voice-turn-state)
- Test: `packages/runtime/test/voice-loop.test.ts`

**Interfaces:**
- Consumes: Task1 `clearBuffer`、Task2 `SentenceSplitter`、Task3 `nextState/VoiceState`;voice-detect `VadDetector/TurnDetector`;providers `SttProvider/TtsProvider/PcmChunk`;`AudioTransport/AudioFrame`;`LightVoiceBus`;`send`。
- Produces:
```ts
interface VoiceLoopDeps {
  transport: AudioTransport;
  vad: VadDetector;
  turnDetector: TurnDetector;
  stt: SttProvider;
  tts: TtsProvider;
  send: (text: string, onToken: (t: string) => void) => Promise<string>;
  memory: Pick<MemoryStore, 'appendMessage'>;
  bus: LightVoiceBus;
  sessionId: string;
  clock?: () => number;
}
class VoiceLoop {
  constructor(deps: VoiceLoopDeps);
  start(): void;        // 订阅 transport.onAudio,进入 listening
  stop(): void;         // 取消订阅 + 当前回合作废
  get state(): VoiceState;  // 供测试断言
}
```

- [ ] **Step 1: 写失败测试**(`packages/runtime/test/voice-loop.test.ts`)。用 InProcess transport(一对 `pipe` 或单实例)、`StubVadDetector(probs)`、`TurnDetector(new StubEouModel(probs))`、`FakeStt`(脚本文本)、`FakeTts`、注入 `send`(把传入 onToken 喂若干 token 后 resolve)、fake memory(记录 appendMessage)、recording bus。断言:
  1. **正常闭环**:喂"语音帧×N(VAD prob 高)→ 静音帧(EOU prob 高判完)"→ state 依次 listening→endpointing→thinking→speaking→listening;bus 收到 `vad:speech_start`/`stt:final`/`tts:first_audio`/`turn:end`;下行收到 FakeTts 的 `tts:chunk` 帧;句级切分调用正确。
  2. **打断**:speaking 期间再喂语音帧 → state→barge_in_pending→listening;`transport.clearBuffer` 被调;半句 `[被用户打断]` 经 `memory.appendMessage(role:'assistant')` 写回;打断后旧 generation 的 TTS 帧不再下行。
  3. **降级**:FakeStt 空文本/抛错 → 回 listening,不崩;非法迁移不崩。
- [ ] **Step 2: 运行确认失败**。`pnpm -F @chat-a/runtime test voice-loop`,Expected: FAIL。
- [ ] **Step 3: 实现 `voice-loop.ts`**。要点:
  - **状态**:`#state: VoiceState='listening'`、`#gen=0`、`#replyAccum=''`、`#audioBuf: PcmFrame[]`、`#unsub`、`#currentTurn: Promise<void>|null`。
  - **迁移**:`#go(event)` 调 `nextState`,合法则设 `#state` + `bus.emit(makeBusEvent(event,...))`,非法 warn 不抛。
  - **onAudio(上行 audio:input)**:转 `PcmFrame`(取 samples/format)喂 `vad.pushFrame`;按结果与状态推进:
    - listening + `event==='speech_start'` → `#go('vad:speech_start')`(endpointing),开始累积 `#audioBuf`。
    - endpointing:累积音频;每帧/静音时 `turnDetector.step({ window:#audioBuf, ... })`,`decision.shouldEndpoint` → `#go('stt:final')` → `#startThinking()`。
    - speaking + `event==='speech_start'` → `#go('vad:speech_start')`(barge_in_pending)→ 立即 `#interrupt()`(v1 即时判真)。
  - **#startThinking()**:`#gen++` 捕获本回合 `gen`;`const text = await #transcribe(#audioBuf)`(把 `#audioBuf` 转 `AsyncIterable<PcmChunk>` 喂 `stt.transcribe`,取最后 `isFinal` 的 text);空/异常→ `#go('vad:speech_end')` 回 listening 返回。否则起回合:
    ```ts
    this.#replyAccum = '';
    const splitter = new SentenceSplitter();
    let firstAudio = false;
    const onToken = (tok: string) => {
      if (gen !== this.#gen) return;          // 作废:本回合已被打断/替换
      this.#replyAccum += tok;
      for (const sentence of splitter.push(tok)) void this.#speak(sentence, gen, () => { firstAudio = this.#ensureSpeaking(firstAudio); });
    };
    this.#currentTurn = this.#send(text, onToken).then((full) => {
      if (gen !== this.#gen) return;
      const tail = splitter.flush(); if (tail) void this.#speak(tail, gen, ...);
      this.#go('turn:end');                    // → listening
    }).catch(() => { if (gen===this.#gen) this.#go('turn:end'); });
    ```
  - **#speak(sentence, gen, onFirst)**:`if (gen!==this.#gen) return;` 然后 `for await (const chunk of this.tts.synthesize(sentence))`:每 chunk **再自检 `gen===this.#gen`**,通过则转 `tts:chunk` AudioFrame `transport.sendAudio`;首 chunk 触发 `tts:first_audio` 迁移(thinking→speaking)。
  - **#interrupt()**:`this.#gen++`(作废在途);`this.transport.clearBuffer()`;若 `#replyAccum.trim()` 非空 → `this.memory.appendMessage({ sessionId, turnId:'interrupted', role:'assistant', content: this.#replyAccum+'[被用户打断]', createdAtMs: this.#now() })`;`#replyAccum=''`、`#audioBuf=[]`、`#go('turn:interrupt')`(→ listening)。**send 不取消**(协作式放弃:onToken/#speak 因 gen 变更已 no-op,见 spec §4 限制)。
  - **类型桥接**(小适配,实现时按真类型):`audio:input` AudioFrame ↔ `PcmFrame`(VAD/STT 输入)、`PcmChunk`(TTS 输出)↔ `tts:chunk` AudioFrame(transport)——同为 samples+sampleRate,写 `#toPcmFrame`/`#toPcmChunk`/`#toTtsFrame` 三个小转换。
  - 全程容错:任一步抛错被 catch,回 listening,不崩(§3.2)。
  - **index.ts** 追加 `export * from './voice-loop'; export * from './sentence-splitter'; export * from './voice-turn-state';`。
- [ ] **Step 4: 运行确认通过**。`pnpm -F @chat-a/runtime typecheck && pnpm -F @chat-a/runtime test`,Expected: PASS(含既有回合测试无回归)。
- [ ] **Step 5: 全仓校验 + Commit**

```bash
pnpm -r typecheck && pnpm -r test
git add packages/runtime/src/voice-loop.ts packages/runtime/src/index.ts packages/runtime/test/voice-loop.test.ts
git commit -m "feat(runtime): VoiceLoop v1 端到端语音回合骨架(听→send→说+核心打断+半句写回,InProcess+Fake)"
```

---

## 自查(对照 spec)
- **覆盖**:§1 文件→Task2/3/4 + Task1(transport);§2 状态机→Task3 + Task4 #go;§3 数据流→Task4 onAudio/#startThinking/#speak;§4 打断+gen+半句写回→Task4 #interrupt(gen 自检作废 + clearBuffer + appendMessage);§5 测试→各 Task Step1 + Task4 三场景;§6 改动清单→Task1 transport + Task4 index.ts;clearBuffer 命名一致(Task1 定义 / Task4 调用)。✅
- **非目标不实现**:pause/resume/wait_for_playout、先 pause 后定夺、预测性生成、autonomy 接入、真引擎、改 Conversation.send 签名——计划无对应任务。✅
- **类型一致**:`clearBuffer`(Task1)/`SentenceSplitter.push|flush`(Task2)/`nextState|VoiceState`(Task3)签名与 Task4 消费一致;voice-detect/providers/transport 用真实签名(已读 audio-transport.ts/vad.ts/turn-detector.ts/stt.ts/tts.ts)。✅
- **占位符**:无 TBD;各 code 步有测试+实现代码或具体结构。
- **并行/串行**:Task1(protocol)∥ Task2(runtime sentence-splitter)∥ Task3(runtime voice-turn-state)→ Task4(runtime voice-loop,串行消费,改 index.ts)。Task2/3 不改 index.ts 避免与 Task4 冲突。
