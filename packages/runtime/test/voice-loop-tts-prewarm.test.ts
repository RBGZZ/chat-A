import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts, TTS_SAMPLE_RATE_HZ } from '@chat-a/providers';
import type {
  PcmChunk,
  TtsOptions,
  TtsProvider,
  TtsStreamSession,
  StreamingTtsProvider,
} from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

// ───────────────────────────── 测试夹具 ─────────────────────────────

/** 放行所有挂起的微任务/Promise。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

function down(transport: InProcessAudioTransport): AudioFrame[] {
  const acc: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') acc.push(f);
  });
  return acc;
}

/** 注入式 fake StreamingSttPort:捕获 handlers(经 onFinal 驱动回合)。 */
function fakeStreamPort(): { port: StreamingSttPort; handlers(): StreamingSttHandlers | null } {
  let handlers: StreamingSttHandlers | null = null;
  const port: StreamingSttPort = {
    openSession(h): StreamingSttSession {
      handlers = h;
      return { pushAudio: () => {}, close: () => {} };
    },
  };
  return { port, handlers: () => handlers };
}

/** 可观测的 fake「同会话流式喂文本」会话(模拟 CosyVoice warm session 生命周期)。 */
class FakeStreamSession implements TtsStreamSession {
  readonly pushed: string[] = [];
  finished = false;
  aborted = false;
  /** 失败注入:开 true 则 chunks 在首次拉取时抛(模拟建连/握手后 WS 失败)。 */
  failOnChunks = false;
  #queue: PcmChunk[] = [];
  #done = false;
  #resolve: (() => void) | undefined;

  push(text: string): void {
    if (this.aborted || this.finished) return;
    this.pushed.push(text);
    // 每句确定性产一块音频(样本数=句长),供 drain 触发 first_audio。
    this.#queue.push({ samples: new Int16Array([text.length]), sampleRate: TTS_SAMPLE_RATE_HZ, channels: 1 });
    this.#wake();
  }

  finish(): void {
    if (this.aborted) return;
    this.finished = true;
    this.#done = true;
    this.#wake();
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    this.#queue = []; // 打断丢弃在途音频
    this.#done = true;
    this.#wake();
  }

  get chunks(): AsyncIterable<PcmChunk> {
    return this.#gen();
  }

  async *#gen(): AsyncIterable<PcmChunk> {
    if (this.failOnChunks) throw new Error('fake warm session 建连/握手失败');
    for (;;) {
      while (this.#queue.length > 0) yield this.#queue.shift() as PcmChunk;
      if (this.#done) return;
      await new Promise<void>((r) => {
        this.#resolve = r;
      });
    }
  }

  #wake(): void {
    const r = this.#resolve;
    this.#resolve = undefined;
    if (r !== undefined) r();
  }
}

/** 支持预热(synthesizeStream)的 fake TTS provider;记录开过的会话 + 逐句 synthesize 调用数。 */
class FakeStreamingTts implements StreamingTtsProvider {
  readonly id = 'fake-stream';
  readonly capabilities = {
    languages: ['*'],
    sampleRate: TTS_SAMPLE_RATE_HZ,
    streaming: true,
    voiceCloning: true,
  };
  readonly sessions: FakeStreamSession[] = [];
  synthesizeCalls = 0;
  /** 若设,synthesizeStream 同步抛(模拟能力门/构造期 fail-fast)。 */
  throwOnOpen = false;
  /** 若设,开出的会话 chunks 抛(模拟建连/握手后 WS 异步失败)。 */
  failSessionChunks = false;

  async *synthesize(text: string): AsyncIterable<PcmChunk> {
    this.synthesizeCalls++;
    yield { samples: new Int16Array([text.length]), sampleRate: TTS_SAMPLE_RATE_HZ, channels: 1 };
  }

  synthesizeStream(_opts?: TtsOptions): TtsStreamSession {
    if (this.throwOnOpen) throw new Error('fake synthesizeStream 同步 fail-fast');
    const s = new FakeStreamSession();
    if (this.failSessionChunks) s.failOnChunks = true;
    this.sessions.push(s);
    return s;
  }
}

/** 只实现 synthesize 的 spy TTS(不支持预热)→ 必走逐句回落。 */
class SpyTts implements TtsProvider {
  readonly id = 'spy';
  readonly capabilities = { languages: ['*'], sampleRate: TTS_SAMPLE_RATE_HZ, streaming: true };
  calls: string[] = [];
  async *synthesize(text: string): AsyncIterable<PcmChunk> {
    this.calls.push(text);
    yield { samples: new Int16Array([text.length]), sampleRate: TTS_SAMPLE_RATE_HZ, channels: 1 };
  }
}

function makeDeps(over: Partial<VoiceLoopDeps> = {}): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
} {
  const transport = new InProcessAudioTransport();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0, 0, 0, 0, 0, 0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '（未用到）', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好呀。');
      return '你好呀。';
    },
    memory: { appendMessage: vi.fn() },
    bus: new LightVoiceBus(),
    sessionId: 's-prewarm',
    clock: () => 1000,
    voicePath: 'stt-stream',
    ...over,
  };
  return { deps, transport };
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('VoiceLoop CosyVoice 预热(warm session)', () => {
  it('① 回合起点即预热(握手);第一句到达走已 warm 会话,不重新握手', async () => {
    const tts = new FakeStreamingTts();
    const fake = fakeStreamPort();
    // 拖住 LLM 首 token:让我们能观察「拿到第一句之前」会话已开。
    let releaseToken: () => void = () => {};
    const gate = new Promise<void>((r) => {
      releaseToken = r;
    });
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      await gate;
      onToken('你好呀。');
      return '你好呀。';
    };
    const { deps } = makeDeps({ tts, streamingStt: fake.port, send });
    const loop = new VoiceLoop(deps);
    loop.start();

    fake.handlers()!.onFinal('在吗');
    await flush();

    // 预热:第一句还没来(send 卡 gate),会话已开 = 已发握手(run-task)。
    expect(tts.sessions.length).toBe(1);
    expect(tts.sessions[0]!.pushed).toEqual([]);
    expect(tts.synthesizeCalls).toBe(0);

    // 放行首 token → 第一句直接喂进**同一** warm 会话(不开第二条 = 不重新握手)。
    releaseToken();
    await flush();
    expect(tts.sessions.length).toBe(1);
    expect(tts.sessions[0]!.pushed).toEqual(['你好呀。']);
    expect(tts.synthesizeCalls).toBe(0); // 没走逐句 synthesize
    expect(tts.sessions[0]!.finished).toBe(true); // 回合收尾发 finish
  });

  it('① 同回合多句复用同一 warm 会话(消除句间重连)', async () => {
    const tts = new FakeStreamingTts();
    const fake = fakeStreamPort();
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('第一句。');
      onToken('第二句。');
      return '第一句。第二句。';
    };
    const { deps } = makeDeps({ tts, streamingStt: fake.port, send });
    const loop = new VoiceLoop(deps);
    loop.start();
    fake.handlers()!.onFinal('说点什么');
    await flush();

    expect(tts.sessions.length).toBe(1); // 只一条会话
    expect(tts.sessions[0]!.pushed).toEqual(['第一句。', '第二句。']);
    expect(tts.synthesizeCalls).toBe(0);
  });

  it('② stop() 打断时干净关闭 warm 会话(abort,不泄漏)', async () => {
    const tts = new FakeStreamingTts();
    const fake = fakeStreamPort();
    // send 卡住:回合停在 speaking,warm 会话仍开着。
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('我正在说话。');
      await new Promise<void>(() => {}); // 永不 resolve
      return '';
    };
    const { deps } = makeDeps({ tts, streamingStt: fake.port, send });
    const loop = new VoiceLoop(deps);
    loop.start();
    fake.handlers()!.onFinal('开始');
    await flush();
    expect(loop.state).toBe('speaking');
    expect(tts.sessions.length).toBe(1);
    expect(tts.sessions[0]!.aborted).toBe(false);

    loop.stop();
    await flush();
    expect(tts.sessions[0]!.aborted).toBe(true); // warm 会话被 abort 关闭
  });

  it('② 新回合抢占时旧 warm 会话被关闭(不泄漏)', async () => {
    const tts = new FakeStreamingTts();
    const fake = fakeStreamPort();
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('上一句。');
      await new Promise<void>(() => {}); // 卡住 → 留在 speaking,会话开着
      return '';
    };
    const { deps } = makeDeps({ tts, streamingStt: fake.port, send });
    const loop = new VoiceLoop(deps);
    loop.start();
    fake.handlers()!.onFinal('第一句话');
    await flush();
    expect(tts.sessions.length).toBe(1);

    // 第二句 final 抢占 → 旧会话必须被关，新会话开启。
    fake.handlers()!.onFinal('第二句话');
    await flush();
    expect(tts.sessions[0]!.aborted).toBe(true); // 旧会话被关
    expect(tts.sessions.length).toBe(2); // 新会话开启(新一轮预热)
  });

  it('③ 不支持预热的 provider 回落逐句 synthesize(行为不变)', async () => {
    const spy = new SpyTts();
    const fake = fakeStreamPort();
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('一句话。');
      return '一句话。';
    };
    const { deps, transport } = makeDeps({ tts: spy, streamingStt: fake.port, send });
    const acc = down(transport);
    const loop = new VoiceLoop(deps);
    loop.start();
    fake.handlers()!.onFinal('hi');
    await flush();

    expect(spy.calls).toEqual(['一句话。']); // 走了逐句 synthesize
    expect(acc.length).toBeGreaterThan(0); // 仍出声
    expect(acc.every((f) => f.type === 'tts:chunk')).toBe(true);
  });

  it('④ 预热同步抛(能力门 fail-fast)→ 本回合静默回落逐句 synthesize,不崩', async () => {
    const tts = new FakeStreamingTts();
    tts.throwOnOpen = true;
    const fake = fakeStreamPort();
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('回落句。');
      return '回落句。';
    };
    const { deps, transport } = makeDeps({ tts, streamingStt: fake.port, send });
    const acc = down(transport);
    const loop = new VoiceLoop(deps);
    loop.start();
    fake.handlers()!.onFinal('hi');
    await flush();

    expect(tts.sessions.length).toBe(0); // 没开成会话
    expect(tts.synthesizeCalls).toBe(1); // 回落逐句 synthesize
    expect(acc.length).toBeGreaterThan(0); // 仍出声
  });

  it('④ 预热会话异步失败(建连/握手抛错)→ 不崩,后续回合回落逐句 synthesize', async () => {
    const tts = new FakeStreamingTts();
    tts.failSessionChunks = true; // 第一回合会话 chunks 抛
    const fake = fakeStreamPort();
    const send = async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('内容。');
      return '内容。';
    };
    const { deps } = makeDeps({ tts, streamingStt: fake.port, send });
    const loop = new VoiceLoop(deps);
    loop.start();

    // 第一回合:预热会话异步失败 → 吞错回 listening,不崩。
    fake.handlers()!.onFinal('first');
    await flush();
    expect(loop.state).toBe('listening');

    // 第二回合:降级闩生效 → 回落逐句 synthesize(不再开会话)。
    tts.failSessionChunks = false;
    fake.handlers()!.onFinal('second');
    await flush();
    expect(tts.synthesizeCalls).toBeGreaterThan(0);
  });
});
