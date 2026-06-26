# 流式 ASR / 全程流式语音 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增连续流式语音路 `voicePath='stt-stream'`：点一次→麦音频持续流给 realtime ASR（qwen3-asr-flash-realtime，服务端 VAD 连续分句）→ 每句 final 驱动现有 LLM+TTS 回合，达成「全程流式」对话。

**Architecture:** runtime 定义 `StreamingSttPort` 接缝（与 `OmniAudioPort` 平级）；providers 实现 `QwenAsrRealtimeStt`（OpenAI-Realtime 风格 WS）；VoiceLoop 加连续路（listening 期持续推流、onFinal 驱动回合、speaking 期暂停推流+本地 VAD 打断）；cli-voice 装配，opt-in，默认批式 stt 不变，失败回落批式。

**Tech Stack:** TypeScript（pnpm workspace），vitest，DashScope realtime WebSocket（OpenAI-Realtime 风格），惰性 `ws` 包。

## Global Constraints

- 包管理器 `pnpm`；测试 `pnpm vitest run <file>`；类型检查 `pnpm typecheck`。中文注释（项目约定）。
- §3.2 永不崩永不哑：WS/key/模型失败一律回落批式 stt 路 + 明确中文提示。
- 纯加法可选注入：不注入 `streamingStt` 或 `voicePath≠stt-stream` → 行为逐字现状（零回归）。
- exactOptionalPropertyTypes：可选字段缺席不写键。
- 音频硬约定 16k/mono/s16le（qwen3-asr-flash-realtime 固定 16k）。
- 复用现有：omni provider 的注入式 WS 范式（`OmniWsLike`/`OmniWsFactory`）、VoiceLoop 回合核心（`#send`/`#speak`/`#go`/`#interrupt`/`#gen`/`#toPcmChunk`/`#resetToListening`）、emotion→PAD 的 prosody 通道（`#send` 第 4 参）。
- 不打印 key。

## 任务依赖与并行分组
- **Phase 1（并行）**：Task 1（runtime StreamingSttPort 接缝 + VoicePath 'stt-stream'）、Task 2（providers QwenAsrRealtimeStt + FakeWs 测试）。
- **Phase 2**：Task 3（连通 smoke 脚本，依赖 Task 2，**手动跑去账号排雷**）、Task 4（VoiceLoop 连续路，依赖 Task 1）。
- **Phase 3**：Task 5（cli-voice 装配，依赖 Task 2+4）。

---

### Task 1: runtime — `StreamingSttPort` 接缝 + VoicePath 'stt-stream'

**Files:**
- Modify: `packages/runtime/src/voice-loop.ts`（接口定义区，`OmniAudioPort` 旁；`VoicePath` 类型）
- Modify: `packages/runtime/src/index.ts`（导出新类型）
- Test: `packages/runtime/test/streaming-stt-port.test.ts`（新）

**Interfaces:**
- Produces:
  - `StreamingSttHandlers { onSpeechStarted(): void; onPartial(text: string, emotion?: SttEmotion, lang?: string): void; onFinal(text: string, emotion?: SttEmotion, lang?: string): void; onError(err: unknown): void; }`
  - `StreamingSttSession { pushAudio(chunk: PcmChunk): void; close(): void; }`
  - `StreamingSttOpts { readonly language?: string; }`
  - `StreamingSttPort { openSession(handlers: StreamingSttHandlers, opts?: StreamingSttOpts): StreamingSttSession; }`
  - `VoicePath` 联合增加 `'stt-stream'`。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/runtime/test/streaming-stt-port.test.ts
import { describe, it, expect } from 'vitest';
import type { StreamingSttPort, StreamingSttSession, VoicePath } from '../src/voice-loop';
import type { PcmChunk } from '@chat-a/providers';

describe('StreamingSttPort 接缝', () => {
  it('可实现端口:openSession 返回带 pushAudio/close 的会话', () => {
    const pushed: PcmChunk[] = [];
    const port: StreamingSttPort = {
      openSession(handlers) {
        // 立刻回一个 final,验证 handler 形状
        handlers.onFinal('你好', { label: 'happy' }, 'zh');
        const session: StreamingSttSession = {
          pushAudio: (c) => pushed.push(c),
          close: () => {},
        };
        return session;
      },
    };
    let finalText = '';
    const s = port.openSession({
      onSpeechStarted() {},
      onPartial() {},
      onFinal(t) { finalText = t; },
      onError() {},
    });
    s.pushAudio({ samples: new Int16Array(160), sampleRate: 16000, channels: 1 });
    s.close();
    expect(finalText).toBe('你好');
    expect(pushed.length).toBe(1);
  });

  it("VoicePath 接受 'stt-stream'", () => {
    const p: VoicePath = 'stt-stream';
    expect(p).toBe('stt-stream');
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/runtime/test/streaming-stt-port.test.ts`
Expected: FAIL（类型不存在 / `'stt-stream'` 不在 VoicePath）

- [ ] **Step 3: 实现**（在 `voice-loop.ts` `OmniAudioPort` 接口附近加；先 Read 定位 `OmniAudioPort` 与 `VoicePath`）

```typescript
/**
 * 连续流式 STT 端口（path stt-stream，§全程流式）：开一条长连接会话,持续 pushAudio,
 * 服务端 VAD 自动分句,经 handlers 吐 speech_started/partial/final 事件。**只转写、不生成回复**
 * (回复仍走现有 LLM+TTS)。形态等价 omni 端口的「连续会话」变体;失败由消费者回落批式 stt。
 */
export interface StreamingSttHandlers {
  /** 服务端 VAD 检测到用户开口。 */
  onSpeechStarted(): void;
  /** 临时转写(流式吐字,可被后续覆盖);emotion/lang 若引擎给出。 */
  onPartial(text: string, emotion?: SttEmotion, lang?: string): void;
  /** 一句定稿 = 一个回合的用户文本;emotion 经现有 prosody 通道并入 PAD。 */
  onFinal(text: string, emotion?: SttEmotion, lang?: string): void;
  /** 连接/协议错误;消费者据此降级(关会话、回落批式 stt)。 */
  onError(err: unknown): void;
}
export interface StreamingSttSession {
  /** 推一帧/块 16k mono s16le 音频到流式转写。 */
  pushAudio(chunk: PcmChunk): void;
  /** 关闭会话(发 finish + 关连接);幂等。 */
  close(): void;
}
export interface StreamingSttOpts {
  /** 输入语种(省略 = 服务端自动检测)。 */
  readonly language?: string;
}
export interface StreamingSttPort {
  openSession(handlers: StreamingSttHandlers, opts?: StreamingSttOpts): StreamingSttSession;
}
```
- `VoicePath`：`export type VoicePath = 'stt' | 'omni' | 'stt-stream';`
- 确认 `SttEmotion`、`PcmChunk` 已 import（voice-loop.ts 已用 `SttEmotion`/`PcmChunk`，复用其 import；`PcmChunk` 来自 `@chat-a/providers`）。
- `packages/runtime/src/index.ts`：确认 `export * from './voice-loop'` 已涵盖（应已有）；若按名导出则补 `StreamingSttPort` 等。

- [ ] **Step 4: 跑确认通过 + 类型**

Run: `pnpm vitest run packages/runtime/test/streaming-stt-port.test.ts`
Expected: PASS
Run: `pnpm --filter @chat-a/runtime typecheck`
Expected: 通过

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/voice-loop.ts packages/runtime/src/index.ts packages/runtime/test/streaming-stt-port.test.ts
git commit -m "feat(voice): StreamingSttPort 接缝 + VoicePath 'stt-stream'(连续流式路,纯加法)"
```

---

### Task 2: providers — `QwenAsrRealtimeStt`（OpenAI-Realtime 风格 WS）

**Files:**
- Create: `packages/providers/src/qwen-asr-realtime-stt.ts`
- Modify: `packages/providers/src/index.ts`（导出）
- Test: `packages/providers/test/qwen-asr-realtime-stt.test.ts`（新）

**Interfaces:**
- Consumes: `PcmChunk`、`SttEmotion`（providers 既有）；`pcmChunkToBase64`-类逻辑（参考 qwen-omni-llm.ts 的音频→base64）。
- Produces:
  - `QwenAsrRealtimeStt` 类，结构上满足 runtime `StreamingSttPort`（`openSession(handlers, opts?) → { pushAudio, close }`）。
  - `QwenAsrRealtimeSttOptions { id; model; apiKey; baseURL; wsFactory?; silenceDurationMs?; }`
  - `QWEN_ASR_REALTIME_URL`（缺省 WS 端点常量）、`DEFAULT_QWEN_ASR_REALTIME_MODEL = 'qwen3-asr-flash-realtime'`
  - 本地 `RealtimeWsLike`/`RealtimeWsFactory`（同 omni 的 WS 注入范式）

- [ ] **Step 1: 写失败测试**（注入 FakeWs，脚本化服务端事件）

```typescript
// packages/providers/test/qwen-asr-realtime-stt.test.ts
import { describe, it, expect } from 'vitest';
import { QwenAsrRealtimeStt } from '../src/qwen-asr-realtime-stt';

// 最小 FakeWs:记录 send 的 JSON,可手动触发 open/message。
function makeFakeWs() {
  const sent: any[] = [];
  let onOpen = () => {};
  let onMsg = (_d: unknown) => {};
  const ws = {
    on(ev: string, cb: any) {
      if (ev === 'open') onOpen = cb;
      else if (ev === 'message') onMsg = cb;
    },
    send(s: string) { sent.push(JSON.parse(s)); },
    close() {},
  };
  return { ws, sent, fireOpen: () => onOpen(), fireMsg: (o: any) => onMsg(JSON.stringify(o)) };
}

describe('QwenAsrRealtimeStt', () => {
  const base = { id: 'qwen-asr-rt', model: 'qwen3-asr-flash-realtime', apiKey: 'k', baseURL: 'wss://x' };

  it('open→发 session.update(server_vad,pcm,16k);收 speech_started/partial/final 触发 handlers', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    const events: string[] = [];
    let finalText = '', finalEmotion: any;
    const session = stt.openSession({
      onSpeechStarted: () => events.push('start'),
      onPartial: (t) => events.push('partial:' + t),
      onFinal: (t, e) => { finalText = t; finalEmotion = e; events.push('final'); },
      onError: () => events.push('error'),
    });
    f.fireOpen();
    f.fireMsg({ type: 'session.created' });
    const upd = f.sent.find((m) => m.type === 'session.update');
    expect(upd).toBeTruthy();
    expect(upd.session.input_audio_format).toBe('pcm');
    expect(upd.session.sample_rate).toBe(16000);
    expect(upd.session.turn_detection.type).toBe('server_vad');
    f.fireMsg({ type: 'input_audio_buffer.speech_started' });
    f.fireMsg({ type: 'conversation.item.input_audio_transcription.text', text: '你好', emotion: 'happy', language: 'zh' });
    f.fireMsg({ type: 'conversation.item.input_audio_transcription.completed', transcript: '你好世界', emotion: 'happy', language: 'zh' });
    expect(events).toContain('start');
    expect(events).toContain('partial:你好');
    expect(finalText).toBe('你好世界');
    expect(finalEmotion).toEqual({ label: 'happy' });
    session.close();
  });

  it('pushAudio 发 input_audio_buffer.append(base64)', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    const s = stt.openSession({ onSpeechStarted(){}, onPartial(){}, onFinal(){}, onError(){} });
    f.fireOpen(); f.fireMsg({ type: 'session.created' });
    s.pushAudio({ samples: new Int16Array([1, 2, 3, 4]), sampleRate: 16000, channels: 1 });
    const ap = f.sent.find((m) => m.type === 'input_audio_buffer.append');
    expect(ap).toBeTruthy();
    expect(typeof ap.audio).toBe('string'); // base64
    expect(ap.audio.length).toBeGreaterThan(0);
  });

  it('error 事件 → onError', () => {
    const f = makeFakeWs();
    const stt = new QwenAsrRealtimeStt({ ...base, wsFactory: () => f.ws as any });
    let errd = false;
    stt.openSession({ onSpeechStarted(){}, onPartial(){}, onFinal(){}, onError: () => { errd = true; } });
    f.fireOpen(); f.fireMsg({ type: 'session.created' });
    f.fireMsg({ type: 'error', error: { message: 'boom' } });
    expect(errd).toBe(true);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/providers/test/qwen-asr-realtime-stt.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**（参考 `qwen-omni-llm.ts` 的 WS 注入范式 + 事件解析；先 Read 它的 `OmniWsLike`/`defaultWsFactory`/`#handleServerEvent` 借形）

```typescript
// packages/providers/src/qwen-asr-realtime-stt.ts
/**
 * Qwen 实时流式 ASR(qwen3-asr-flash-realtime)——DashScope realtime WebSocket(OpenAI-Realtime 风格)。
 * 实现 runtime 的 StreamingSttPort(结构上满足):openSession 开长连接,持续 pushAudio,服务端 VAD 连续分句,
 * 经 handlers 吐 speech_started/partial/final(带 7 类情绪)。与 qwen-omni-llm 同源 WS 范式。
 */
import type { PcmChunk } from './audio';
import type { SttEmotion, SttEmotionLabel } from './stt';

/** realtime WS 端点(缺省;可经 baseURL 覆盖)。 */
export const QWEN_ASR_REALTIME_URL = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
export const DEFAULT_QWEN_ASR_REALTIME_MODEL = 'qwen3-asr-flash-realtime';

/** 最小可注入 WS 接口(同 omni 的 OmniWsLike)。 */
export interface RealtimeWsLike {
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
  on(event: 'close', cb: (code?: number, reason?: unknown) => void): void;
  send(data: string): void;
  close(): void;
}
export type RealtimeWsFactory = (url: string, opts: { readonly headers: Record<string, string> }) => RealtimeWsLike;

export interface QwenAsrRealtimeSttOptions {
  readonly id: string;
  readonly model: string;
  readonly apiKey: string;
  readonly baseURL: string;
  readonly wsFactory?: RealtimeWsFactory;
  /** server_vad 静音断句阈(ms);缺省 400(连续对话更跟手)。 */
  readonly silenceDurationMs?: number;
}

const VALID_EMOTIONS: ReadonlySet<string> = new Set([
  'surprised', 'neutral', 'happy', 'sad', 'disgusted', 'angry', 'fearful',
]);
function toEmotion(raw: unknown): SttEmotion | undefined {
  return typeof raw === 'string' && VALID_EMOTIONS.has(raw)
    ? { label: raw as SttEmotionLabel }
    : undefined;
}

/** 默认 WS 工厂:惰性 import `ws`(node),避免装配期触网/打包静态解析。 */
const defaultWsFactory: RealtimeWsFactory = (url, opts) => {
  // 与 qwen-omni-llm 同款:运行时 require('ws')。
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const WS = (eval('require') as NodeRequire)('ws');
  return new WS(url, { headers: opts.headers }) as unknown as RealtimeWsLike;
};

interface Handlers {
  onSpeechStarted(): void;
  onPartial(text: string, emotion?: SttEmotion, lang?: string): void;
  onFinal(text: string, emotion?: SttEmotion, lang?: string): void;
  onError(err: unknown): void;
}

export class QwenAsrRealtimeStt {
  readonly #model: string;
  readonly #apiKey: string;
  readonly #baseURL: string;
  readonly #wsFactory: RealtimeWsFactory;
  readonly #silenceMs: number;

  constructor(opts: QwenAsrRealtimeSttOptions) {
    this.#model = opts.model;
    this.#apiKey = opts.apiKey;
    this.#baseURL = opts.baseURL;
    this.#wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.#silenceMs = opts.silenceDurationMs ?? 400;
  }

  openSession(handlers: Handlers, opts?: { readonly language?: string }) {
    const url = `${this.#baseURL}?model=${encodeURIComponent(this.#model)}`;
    const ws = this.#wsFactory(url, {
      headers: { Authorization: `Bearer ${this.#apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
    });
    let open = false;
    let closed = false;
    ws.on('open', () => { open = true; });
    ws.on('error', (err) => handlers.onError(err));
    ws.on('close', () => { closed = true; });
    ws.on('message', (data) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>; }
      catch { return; }
      const type = msg['type'];
      if (type === 'session.created') {
        ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            modalities: ['text'],
            input_audio_format: 'pcm',
            sample_rate: 16000,
            ...(opts?.language ? { input_audio_transcription: { language: opts.language } } : {}),
            turn_detection: { type: 'server_vad', silence_duration_ms: this.#silenceMs },
          },
        }));
      } else if (type === 'input_audio_buffer.speech_started') {
        handlers.onSpeechStarted();
      } else if (type === 'conversation.item.input_audio_transcription.text') {
        const text = String((msg['text'] ?? '') as string) + String((msg['stash'] ?? '') as string);
        if (text.length > 0) handlers.onPartial(text, toEmotion(msg['emotion']), msg['language'] as string | undefined);
      } else if (type === 'conversation.item.input_audio_transcription.completed') {
        const text = String((msg['transcript'] ?? '') as string);
        handlers.onFinal(text, toEmotion(msg['emotion']), msg['language'] as string | undefined);
      } else if (type === 'error' || type === 'conversation.item.input_audio_transcription.failed') {
        handlers.onError(msg['error'] ?? msg);
      }
    });

    return {
      pushAudio: (chunk: PcmChunk): void => {
        if (!open || closed) return; // 未连上/已关:静默丢弃(降级)
        const buf = Buffer.alloc(chunk.samples.length * 2);
        for (let i = 0; i < chunk.samples.length; i++) buf.writeInt16LE(chunk.samples[i] ?? 0, i * 2);
        try { ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: buf.toString('base64') })); }
        catch { /* 推流失败不崩 */ }
      },
      close: (): void => {
        if (closed) return;
        closed = true;
        try { ws.send(JSON.stringify({ type: 'session.finish' })); } catch { /* ignore */ }
        try { ws.close(); } catch { /* ignore */ }
      },
    };
  }
}
```
> 注：`defaultWsFactory` 的惰性 require 写法对齐 qwen-omni-llm.ts 现状（Read 它确认用的是 `await import('ws')` 还是 `require`，**照它的写法改**，保持一致——上面 eval('require') 是占位，以 omni 实际写法为准）。

- [ ] **Step 4: 跑确认通过**

Run: `pnpm vitest run packages/providers/test/qwen-asr-realtime-stt.test.ts`
Expected: PASS（3 用例）

- [ ] **Step 5: 导出 + typecheck + 提交**

`packages/providers/src/index.ts` 加 `export * from './qwen-asr-realtime-stt';`
Run: `pnpm --filter @chat-a/providers typecheck` → 通过
```bash
git add packages/providers/src/qwen-asr-realtime-stt.ts packages/providers/src/index.ts packages/providers/test/qwen-asr-realtime-stt.test.ts
git commit -m "feat(voice): QwenAsrRealtimeStt 流式ASR provider(realtime WS,server_vad连续分句,带情绪)"
```

---

### Task 3: 连通 smoke（账号排雷，依赖 Task 2）

**Files:**
- Create: `scripts/asr-realtime-smoke.ts`
- Modify: `package.json`（加 `"smoke:asr-rt": "tsx scripts/asr-realtime-smoke.ts"`）

**Interfaces:** Consumes `QwenAsrRealtimeStt`（Task 2）、`out.wav`（仓库根，24k TTS 产物）、`decodeWav`/重采样（参考 `scripts/asr-smoke.ts`）。

- [ ] **Step 1: 写脚本**（仿 `scripts/asr-smoke.ts` 的 loadEnvLocal + 读 wav + 重采样到 16k；无 key 跳过退出 0、不打印 key）

```typescript
// scripts/asr-realtime-smoke.ts
/**
 * realtime 流式 ASR 连通 smoke(手动跑,不进 CI):建 WS + 喂 out.wav(降16k) + 打印 partial/final,
 * 确认账号能用 qwen3-asr-flash-realtime(排雷:日期快照/邀测)。无 key 跳过退出 0,绝不打印 key。
 * 跑法:pnpm smoke:asr-rt [path/to.wav]
 */
import { readFileSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import process, { argv, cwd, env, stdout } from 'node:process';
import { QwenAsrRealtimeStt, QWEN_ASR_REALTIME_URL, DEFAULT_QWEN_ASR_REALTIME_MODEL, pcmChunk } from '../packages/providers/src/index';
import { parseDotEnv, applyDotEnv } from '../packages/client/src/env-file';
import { decodeWav } from '../packages/client/src/audio/wav';

function loadEnvLocal(): void {
  try { applyDotEnv(parseDotEnv(readFileSync(join(cwd(), '.env.local'), 'utf8')), env); } catch { /* ignore */ }
}
// 线性重采样到 16k(smoke 用,够验连通);抄 scripts/asr-smoke.ts 的 resampleMonoLinear。
function resample16k(samples: Int16Array, from: number): Int16Array {
  if (from === 16000) return samples;
  const ratio = 16000 / from;
  const out = new Int16Array(Math.max(1, Math.round(samples.length * ratio)));
  for (let i = 0; i < out.length; i++) {
    const p = i / ratio, i0 = Math.floor(p), i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = Math.round((samples[i0] ?? 0) + ((samples[i1] ?? 0) - (samples[i0] ?? 0)) * (p - i0));
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const key = env['CHAT_A_DASHSCOPE_API_KEY'];
  if (!key) { stdout.write('[smoke:asr-rt] 跳过:未填 CHAT_A_DASHSCOPE_API_KEY。\n'); return; }
  const arg = argv[2] ?? 'out.wav';
  const wavPath = isAbsolute(arg) ? arg : resolve(cwd(), arg);
  const { samples, sampleRate } = decodeWav(new Uint8Array(readFileSync(wavPath)));
  const pcm16 = resample16k(samples, sampleRate);
  stdout.write(`[smoke:asr-rt] ${wavPath} ${sampleRate}Hz→16k, ${(pcm16.length / 16000).toFixed(2)}s, model=${DEFAULT_QWEN_ASR_REALTIME_MODEL}\n`);

  const stt = new QwenAsrRealtimeStt({
    id: 'qwen-asr-rt', model: env['CHAT_A_STT_REALTIME_MODEL'] ?? DEFAULT_QWEN_ASR_REALTIME_MODEL,
    apiKey: key, baseURL: env['CHAT_A_STT_REALTIME_BASE_URL'] ?? QWEN_ASR_REALTIME_URL,
  });
  await new Promise<void>((done) => {
    let finals = 0;
    const session = stt.openSession({
      onSpeechStarted: () => stdout.write('  [speech_started]\n'),
      onPartial: (t) => stdout.write(`  partial: ${t}\n`),
      onFinal: (t, e, l) => { finals++; stdout.write(`  FINAL: ${t}  emotion=${e?.label} lang=${l}\n`); },
      onError: (err) => { stdout.write(`  [error] ${err instanceof Error ? err.message : JSON.stringify(err)}\n`); },
    });
    // 分 ~100ms(1600样本)一包推;推完留 2s 收尾再关。
    let off = 0;
    const tick = setInterval(() => {
      if (off >= pcm16.length) {
        clearInterval(tick);
        setTimeout(() => { session.close(); stdout.write(`[smoke:asr-rt] 完成,共 ${finals} 句 final\n`); done(); }, 2000);
        return;
      }
      session.pushAudio(pcmChunk(pcm16.subarray(off, off + 1600), 16000));
      off += 1600;
    }, 100);
  });
}
await main();
```
> 若 `pcmChunk` 签名不符,以 providers 实际导出为准(Read providers/src/audio.ts)。

- [ ] **Step 2: 跑(真网络,手动排雷)**

Run: `pnpm smoke:asr-rt`
Expected: 打印若干 `partial:` 与至少一条 `FINAL: 好呀阳光暖暖的…`（证明账号能用 realtime ASR）。
**若报 model not found / 鉴权 / 邀测错** → 停下,记录错误,回报主代理(账号/端点需控制台核实,不要硬继续后续集成)。

- [ ] **Step 3: 提交**

```bash
git add scripts/asr-realtime-smoke.ts package.json
git commit -m "chore(voice): realtime ASR 连通 smoke 脚本(pnpm smoke:asr-rt,账号排雷)"
```

---

### Task 4: VoiceLoop 连续路（依赖 Task 1）

**Files:**
- Modify: `packages/runtime/src/voice-loop.ts`
- Test: `packages/runtime/test/voice-loop-stt-stream.test.ts`（新）

**Interfaces:**
- Consumes: `StreamingSttPort`/`StreamingSttSession`（Task 1）；现有 `#send`/`#speak`/`#go`/`#interrupt`/`#gen`/`#toPcmChunk`/`#resetToListening`/`#state`/`SentenceSplitter`。
- Produces: `VoiceLoopDeps` 增 `streamingStt?: StreamingSttPort`；连续路行为。

**实现要点（先 Read voice-loop.ts 全貌,严格复用现有方法名）：**

- [ ] **Step 1: 写失败测试**（注入 fake StreamingSttPort + fake STT/TTS，驱动 onFinal→回合、speaking 期暂停推流）

```typescript
// packages/runtime/test/voice-loop-stt-stream.test.ts
import { describe, it, expect, vi } from 'vitest';
import { VoiceLoop } from '../src/voice-loop';
import type { StreamingSttPort, StreamingSttHandlers } from '../src/voice-loop';
import { InProcessAudioTransport, makeDataFrame, STT_AUDIO_FORMAT } from '@chat-a/protocol';
import { LightVoiceBus } from '../src/index';
// ↑ 具体依赖按现有 voice-loop 测试的脚手架来(Read packages/runtime/test/voice-loop.test.ts 借 setup)。

describe('VoiceLoop 连续流式路 (stt-stream)', () => {
  function setup() {
    let handlers: StreamingSttHandlers | null = null;
    const pushed: unknown[] = [];
    const port: StreamingSttPort = {
      openSession(h) { handlers = h; return { pushAudio: (c) => pushed.push(c), close: () => {} }; },
    };
    const sendSpy = vi.fn(async (_t: string, _on: (s: string) => void) => '回复');
    // 复用现有 fake tts / bus / transport(照 voice-loop.test.ts);此处省略,执行时按现有脚手架补全。
    return { port, get handlers() { return handlers; }, pushed, sendSpy };
  }

  it('onFinal → 触发 #send 回合(走 LLM+TTS)', async () => {
    const t = setup();
    // 构造 VoiceLoop:voicePath:'stt-stream', streamingStt: t.port, send: t.sendSpy, 其余注入 fake(照现有用例)
    // loop.start() 后 handlers 应已注册;触发 onFinal:
    // t.handlers!.onFinal('你好世界', { label: 'happy' });
    // await microtasks;
    // expect(t.sendSpy).toHaveBeenCalledWith('你好世界', expect.any(Function), expect.anything(), { label: 'happy' });
    expect(true).toBe(true); // 占位:执行时按现有 voice-loop 测试脚手架写实(见下方实现契约)
  });
});
```
> **执行说明**:本测试的脚手架(fake vad/turnDetector/stt/tts/memory/bus/transport)**照 `packages/runtime/test/voice-loop.test.ts` 现有 setup 复制**。断言三点:(a) `onFinal(text,emotion)` → `deps.send` 被以 `(text, onToken, signal, emotion)` 调用且走 TTS;(b) `loop.start()` 后注入端口的 `openSession` 被调、麦帧(audio:input)在 listening 态经 `session.pushAudio` 推出;(c) speaking 态(已起回合)再来 audio:input → **不** pushAudio(断言 pushed 数量不增)。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/runtime/test/voice-loop-stt-stream.test.ts`
Expected: FAIL（streamingStt 未支持）

- [ ] **Step 3: 实现**（voice-loop.ts，先 Read 定位下列锚点）

3a. `VoiceLoopDeps` 加（紧邻 `omni?` 字段）：
```typescript
  /**
   * 连续流式 STT 端口(path stt-stream,**可选、纯加法**)。不注入(缺省)→ 不走连续路,逐字现状。
   * 注入 **且** `voicePath==='stt-stream'` → 开机开一条长连接会话,listening 期麦帧持续 pushAudio,
   * 服务端 VAD 分句:onFinal → 走现有 #send+TTS 回合(emotion 经 prosody 并入 PAD);speaking 期暂停推流,
   * 本地 EchoGuard/能量 VAD 仍管打断。WS 失败 → onError 降级回落批式 stt,绝不崩(§3.2)。
   */
  readonly streamingStt?: StreamingSttPort;
```

3b. 类私有字段：
```typescript
  #streamSession: StreamingSttSession | null = null;
  #streamDegraded = false; // onError 后置 true:本会话退回批式 stt(本地 VAD+endpointing)
```
存 `#streamingStt = deps.streamingStt`（构造）；判定连续路的私有 getter：
```typescript
  get #useStream(): boolean {
    return this.#voicePath === 'stt-stream' && this.#streamingStt !== undefined && !this.#streamDegraded;
  }
```

3c. `start()`：在现有 `loop.start()` 逻辑末尾,若 `#useStream` 则 `#openStream()`：
```typescript
  #openStream(): void {
    if (this.#streamingStt === undefined || this.#streamSession !== null) return;
    try {
      this.#streamSession = this.#streamingStt.openSession({
        onSpeechStarted: () => {
          // listening:仅作在场/状态提示(回合由 onFinal 驱动);speaking:由本地 VAD 管打断,这里不重复。
          if (this.#state === 'listening') this.#bus.emit(/* vad:speech_start,参照现有 emit 形态 */ ...);
        },
        onPartial: () => { /* 可选:UI/状态;本切片不强用 */ },
        onFinal: (text, emotion) => { void this.#runStreamTurn(text, emotion); },
        onError: (err) => {
          console.warn('[VoiceLoop] 流式 ASR onError,降级回批式 stt:', err);
          this.#streamDegraded = true;
          try { this.#streamSession?.close(); } catch { /* ignore */ }
          this.#streamSession = null;
          this.#resetToListening();
        },
      }, /* opts: { language: this.#sttLanguage } 若有 */ {});
    } catch (err) {
      console.warn('[VoiceLoop] 流式 ASR openSession 失败,降级批式 stt:', err);
      this.#streamDegraded = true;
    }
  }
```
（`onSpeechStarted` 的 emit 形态按现有 `#emit('vad:speech_start')` 用法 Read 后照抄;`#sttLanguage` 若不存在则传 `{}`。）

3d. `#onAudio` 顶部加连续路分支（在现有 `if (frame.type !== 'audio:input') return;` + 取 pcm 之后）：
```typescript
    if (this.#useStream) {
      // 连续路:listening 持续推流给云端(服务端VAD分句);speaking 暂停推流(防回声)+本地VAD管打断。
      if (this.#state === 'speaking') {
        // 复用现有 speaking 态打断逻辑(EchoGuard/能量VAD → #interrupt);不推流。
        this.#handleSpeakingBargeIn(pcm, result, evt); // ← 把现有 speaking 分支抽成此方法复用(见 3f)
        return;
      }
      // listening / thinking:持续推流(thinking 期也继续推,云端会归入下一句;简单稳妥)。
      try { this.#streamSession?.pushAudio(this.#toPcmChunk(pcm)); } catch { /* 推流失败不崩 */ }
      return;
    }
```
（注意:`this.#vad.pushFrame(pcm)` 仍要在前面调以更新 `#lastFrameSamples` 等给 EchoGuard;Read 现有 #onAudio 顶部,确保 `result`/`evt` 在分支前已算出。）

3e. 新增 `#runStreamTurn(text, emotion)`：复用 #startThinking 的「send+speak」核心（678-721 行那段）。**重构**：把 #startThinking 中「拿到 text/emotion 之后」的回合执行段(从 `this.#go('stt:final', {text})` 到 `.finally(...)`，约 668-721 行)抽成 `#runTurn(text: string, emotion: SttEmotion | undefined, gen: number, fromState: VoiceState)`；`#startThinking` 与 `#runStreamTurn` 都调它。
```typescript
  async #runStreamTurn(text: string, emotion?: SttEmotion): Promise<void> {
    if (text.trim().length === 0) return; // 空 final 忽略
    const gen = ++this.#gen;
    // 连续路:从 listening 直接进 thinking(无 endpointing 态)。#runTurn 内 #go 用合法迁移。
    this.#runTurn(text, emotion, gen);
  }
```
（`#runTurn` 的状态迁移:批式路从 `endpointing` 经 `stt:final`;连续路从 `listening` 经 `vad:speech_start`+`stt:final` 或直接允许 `listening→thinking`。**执行时 Read `voice-turn-state.ts` 迁移表**,若 `listening→thinking` 不合法,在连续路先 `#go('vad:speech_start')` 再 `#go('stt:final')`;必要时给 stt-stream 加一条迁移。保持「永不崩」:迁移失败 → resetToListening。）

3f. 把现有 `#onAudio` 的 `if (this.#state === 'speaking') { ... }` 整块抽成 `#handleSpeakingBargeIn(pcm, result, evt)` 方法,原处调用它;连续路分支(3d)也调它。**纯重构,行为不变**(现有 speaking 测试须仍绿)。

3g. `stop()`/`close()`：关闭流式会话：
```typescript
    try { this.#streamSession?.close(); } catch { /* ignore */ }
    this.#streamSession = null;
```

- [ ] **Step 4: 跑确认通过 + 全量不回归**

Run: `pnpm vitest run packages/runtime/test/voice-loop-stt-stream.test.ts packages/runtime/test/voice-loop.test.ts packages/runtime/test/voice-loop-echo-guard.test.ts`
Expected: 全绿（连续路新用例 + 现有 speaking/echo-guard 因 3f 重构不回归）
Run: `pnpm --filter @chat-a/runtime typecheck`

- [ ] **Step 5: 提交**

```bash
git add packages/runtime/src/voice-loop.ts packages/runtime/test/voice-loop-stt-stream.test.ts
git commit -m "feat(voice): VoiceLoop 连续流式路——listening持续推流+onFinal驱动回合+speaking暂停推流防回声(复用回合核心,纯加法)"
```

---

### Task 5: cli-voice 装配（依赖 Task 2+4）

**Files:**
- Modify: `packages/client/src/cli-voice.ts`
- Test: `packages/client/test/cli-voice-stt-stream.test.ts`（新）

**Interfaces:**
- Consumes: `QwenAsrRealtimeStt`/`QWEN_ASR_REALTIME_URL`/`DEFAULT_QWEN_ASR_REALTIME_MODEL`（Task 2）；`StreamingSttPort`、`VoicePath`（Task 1/4）；`VoiceLoopDeps.streamingStt`（Task 4）。
- Produces: `createStreamingSttPort(env)`；`loadVoicePath` 识别 `'stt-stream'`；`startVoiceMode` 注入。

- [ ] **Step 1: 写失败测试**

```typescript
// packages/client/test/cli-voice-stt-stream.test.ts
import { describe, it, expect } from 'vitest';
import { createStreamingSttPort, loadVoicePath } from '../src/cli-voice';

describe('cli-voice 流式路装配', () => {
  it("loadVoicePath 识别 'stt-stream'", () => {
    expect(loadVoicePath({ CHAT_A_VOICE_PATH: 'stt-stream' } as any)).toBe('stt-stream');
    expect(loadVoicePath({ CHAT_A_VOICE_PATH: 'omni' } as any)).toBe('omni');
    expect(loadVoicePath({} as any)).toBe('stt');
  });
  it('有 key → 构造出流式端口', () => {
    const p = createStreamingSttPort({ CHAT_A_DASHSCOPE_API_KEY: 'k' } as any);
    expect(p).toBeDefined();
    expect(typeof p!.openSession).toBe('function');
  });
  it('缺 key → undefined(回落批式)', () => {
    expect(createStreamingSttPort({} as any)).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm vitest run packages/client/test/cli-voice-stt-stream.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**（cli-voice.ts；先 Read `loadVoicePath`/`createOmniAudioPort`/`startVoiceMode`）

3a. import 增加（从 `@chat-a/providers`）：`QwenAsrRealtimeStt, QWEN_ASR_REALTIME_URL, DEFAULT_QWEN_ASR_REALTIME_MODEL`；从 `@chat-a/runtime` type `StreamingSttPort`。

3b. `loadVoicePath` 改为识别三值：
```typescript
export function loadVoicePath(env: NodeJS.ProcessEnv): VoicePath {
  const v = (env['CHAT_A_VOICE_PATH'] ?? '').toLowerCase();
  if (v === 'omni') return 'omni';
  if (v === 'stt-stream') return 'stt-stream';
  return 'stt';
}
```

3c. 新增 `createStreamingSttPort`（仿 `createOmniAudioPort` 的 key 缺失/失败回落范式）：
```typescript
export function createStreamingSttPort(env: NodeJS.ProcessEnv): StreamingSttPort | undefined {
  const apiKey = env['CHAT_A_DASHSCOPE_API_KEY'];
  if (apiKey === undefined || apiKey.length === 0) {
    stdout.write('[语音] CHAT_A_VOICE_PATH=stt-stream 但缺 CHAT_A_DASHSCOPE_API_KEY,已回落批式 STT 路径\n');
    return undefined;
  }
  try {
    return new QwenAsrRealtimeStt({
      id: 'qwen-asr-rt',
      model: env['CHAT_A_STT_REALTIME_MODEL'] ?? DEFAULT_QWEN_ASR_REALTIME_MODEL,
      apiKey,
      baseURL: env['CHAT_A_STT_REALTIME_BASE_URL'] ?? QWEN_ASR_REALTIME_URL,
    });
  } catch (err) {
    stdout.write(`[语音] 流式 ASR 端口构造失败,已回落批式 STT:${err instanceof Error ? err.message : String(err)}\n`);
    return undefined;
  }
}
```

3d. `startVoiceMode`：在现有构造 omni 的同区域，加流式端口构造 + 注入 loopDeps（先 Read 现有 `wantOmni`/`omni`/`effectivePath`/loopDeps 注入处，照 exactOptionalPropertyTypes 风格加）：
```typescript
  const wantStream = loadVoicePath(env) === 'stt-stream';
  const streamingStt = wantStream ? createStreamingSttPort(env) : undefined;
  // 生效路径:流式端口真构造出 → 'stt-stream';否则按 omni/ stt 既有逻辑回落。
```
loopDeps 注入：`...(streamingStt !== undefined ? { streamingStt, voicePath: 'stt-stream' as const } : {})`（与 omni 的注入互斥；omni 优先级与回落顺序按现有 effectivePath 逻辑协调——若同时配 omni 与 stt-stream，约定 stt-stream 优先或 omni 优先**择一并注释**，推荐：显式 `CHAT_A_VOICE_PATH` 单值决定，不会同时）。状态行 `info.path` 如实反映。

- [ ] **Step 4: 跑确认通过 + 全量 + typecheck**

Run: `pnpm vitest run packages/client/test/cli-voice-stt-stream.test.ts`
Expected: PASS
Run: `pnpm vitest run`（全量,零回归）
Run: `pnpm typecheck`（全工作区）

- [ ] **Step 5: 重建 desktop bundle + 提交**

```bash
pnpm --filter @chat-a/desktop run build:bundle
git add packages/client/src/cli-voice.ts packages/client/test/cli-voice-stt-stream.test.ts
git commit -m "feat(voice): cli-voice 装配连续流式路(createStreamingSttPort+loadVoicePath识别stt-stream+startVoiceMode注入)"
```

---

## Self-Review（作者自查）

**Spec coverage**：spec §3.1 接缝→Task1；§3.2 provider→Task2；§3.3 VoiceLoop 连续路→Task4；§3.4 装配→Task5；§5 降级→Task4(onError 回落)+Task5(key 缺回落);§6 测试→各 Task TDD;§7 前置 smoke→Task3;§2 范围(opt-in/默认不变/qwen3 模型/回声暂停推流)→Task4(3d speaking 暂停)+Task5(opt-in)。覆盖完整。

**Placeholder scan**：Task1/2/3/5 代码完整可落。Task4 因深改 VoiceLoop 状态机、且其确切行号/迁移表需执行时 Read，给了**明确的锚点 + 重构指令 + 复用方法名 + 状态迁移兜底策略**（非「TODO」式占位，是「Read 现有 X 照锚点改」的可执行指令）；其单测 setup 显式指明「照 voice-loop.test.ts 脚手架复制」。这是改既有大文件的必要形态。

**Type consistency**：`StreamingSttPort.openSession(handlers, opts?)→{pushAudio,close}` 在 Task1 定义、Task2 结构实现、Task4 消费、Task5 装配，签名一致；`onFinal(text, emotion?, lang?)` 一致；`VoicePath 'stt-stream'` 一致；emotion 用 `SttEmotion{label}` 一致。

**已知执行期注意**：Task4 是最重项(改 VoiceLoop 状态机),建议单独 subagent + 仔细 Read voice-turn-state.ts;若 `listening→thinking` 迁移不存在,需在 stt-stream 下补合法迁移或两步 #go,并保「迁移失败→resetToListening」兜底。
