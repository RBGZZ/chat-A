import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type BusEvent,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import type { SttResult, SttProvider, TtsProvider, TtsOptions, PcmChunk } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps } from '../src/voice-loop';

// ───────────────────────────── 测试夹具 ─────────────────────────────

/** 构造一个 16k mono Int16 的上行 audio:input AudioFrame（带显式时刻）。 */
function micFrame(timestampMs: number): AudioFrame {
  const pcm: PcmFrame = {
    samples: new Int16Array(160), // 10ms @16k
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs,
  };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

/** 记录 appendMessage 的 fake memory。 */
function fakeMemory(): { appendMessage: ReturnType<typeof vi.fn>; calls: unknown[] } {
  const calls: unknown[] = [];
  const appendMessage = vi.fn((m: unknown) => {
    calls.push(m);
  });
  return { appendMessage, calls };
}

/** 收一对 (down frames, bus events) 的记录器。 */
function recorders(transport: InProcessAudioTransport, bus: LightVoiceBus) {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  const events: BusEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { down, events };
}

/**
 * 组装 deps。
 * - vad 概率：高=有声（≥0.5）；低=静音。speechStart/EndFrames 默认各 2 帧去抖。
 * - eou 概率高（0.9 ≥ zh 0.7）→ 静音够长即判 Finished。
 * - send：把若干 token 喂给 onToken 后 resolve 完整回复。
 */
function makeDeps(over: Partial<VoiceLoopDeps> = {}): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
  bus: LightVoiceBus;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好。');
      onToken('很高兴见到你。');
      return '你好。很高兴见到你。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport, bus };
}

/** 驱动「语音 N 帧 → 长静音帧（时间戳跳大,使 silenceMs 远超 endpointing 窗）」。 */
async function driveSpeechThenSilence(loop: VoiceLoop, transport: InProcessAudioTransport): Promise<void> {
  // 4 帧有声（前 2 帧去抖后 speech_start）
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  // 静音帧：前 2 帧让 VAD 转 speech_end（result.speaking=false），时间戳大幅前跳制造长静音
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  // 此后 speaking=false，下一帧时间戳跳到 +10s → silenceMs≈10s ≫ zh maxDelay，必 Finished
  transport.sendAudio(micFrame(10_050));
  await flush();
}

/** 放行所有挂起的微任务/Promise（FakeStt/FakeTts/send 均同步即时,多轮确保链式 await 跑透）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('runtime/VoiceLoop', () => {
  it('① 正常闭环：listening→endpointing→thinking→speaking→listening + BusEvent + 下行 tts:chunk', async () => {
    const { deps, transport, bus } = makeDeps();
    const { down, events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();
    expect(loop.state).toBe('listening');

    await driveSpeechThenSilence(loop, transport);
    await flush();

    // 终态回 listening（走完闭环）
    expect(loop.state).toBe('listening');

    // BusEvent 顺序（只看 voice 相关 action）
    const actions = events.map((e) => e.action).filter((a) => a !== 'turn:start');
    expect(actions).toEqual([
      'vad:speech_start',
      'stt:final',
      'tts:first_audio',
      'turn:end',
    ]);

    // stt:final 携带真转写文本
    const sttFinal = events.find((e) => e.action === 'stt:final');
    expect(sttFinal && (sttFinal.data as { text: string }).text).toBe('你好小雪');

    // 下行收到 FakeTts 的 tts:chunk 帧（句级切分 → 至少两句 → 多块）
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((f) => f.type === 'tts:chunk')).toBe(true);
    // seq 单调递增
    const seqs = down.map((f) => (f.payload as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it('② 打断：speaking 中再来语音 → barge_in_pending→listening + clearBuffer + 半句写回 + 旧 gen 帧不再下行', async () => {
    const mem = fakeMemory();
    // send 不立即 resolve：先吐第一句触发 speaking，再 await 一个我们控制的闸门
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      // 索引 0~6 供 driveSpeechThenSilence(4 有声 + 3 静音);7~8 供 barge-in 两帧(高→speech_start)
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      send: async (_t, onToken) => {
        onToken('我正在说一句话。'); // 含句末标点 → 切出整句 → 触发 speaking,进 #replyAccum
        await gate; // 卡住,模拟回复尚未说完即被打断
        onToken('后面还没说完。'); // 打断后 gen 已变 → 此 token no-op
        return '我正在说一句话。后面还没说完。';
      },
    });
    const { down } = recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(loop, transport);
    await flush();
    // 此刻应已进 speaking（第一句已下行）
    expect(loop.state).toBe('speaking');
    const downBeforeInterrupt = down.length;
    expect(downBeforeInterrupt).toBeGreaterThan(0);

    // speaking 中再来语音 → 打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();

    expect(loop.state).toBe('listening');
    expect(clearSpy).toHaveBeenCalled();

    // 半句写回（assistant + [被用户打断]）
    expect(mem.appendMessage).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; content: string };
    expect(written.role).toBe('assistant');
    expect(written.content).toContain('[被用户打断]');
    expect(written.content).toContain('我正在说一句话。');

    // 放行被卡住的 send：打断后旧 gen 的后续 token 不再下行
    release();
    await flush();
    expect(down.length).toBe(downBeforeInterrupt); // 打断后无新 tts:chunk
  });

  it('④ 真取消：barge-in 打断时本回合 send 的 signal 变 aborted', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let capturedSignal: AbortSignal | undefined;
    let abortedAtSend = false;
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      // 扩展签名:(text, onToken, signal?) —— 捕获 signal,监听其 abort
      send: async (_t, onToken, signal?: AbortSignal) => {
        capturedSignal = signal;
        signal?.addEventListener('abort', () => {
          abortedAtSend = true;
        });
        onToken('我正在说一句话。'); // 触发 speaking,进 #replyAccum
        await gate; // 卡住直到被打断
        onToken('后面还没说完。'); // 打断后 no-op
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(loop, transport);
    await flush();
    expect(loop.state).toBe('speaking');
    // send 拿到了一个未取消的 signal
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal?.aborted).toBe(false);

    // 打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();

    // 真取消:本回合 signal 已 aborted(底层 LLM 流会真停)
    expect(capturedSignal?.aborted).toBe(true);
    expect(abortedAtSend).toBe(true);
    expect(loop.state).toBe('listening');

    // 半句写回仍与现状一致
    const written = mem.calls[0] as { role: string; content: string };
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('④ send 以 AbortError reject(被打断回合)不致崩、不重复 reset', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      send: async (_t, onToken, signal?: AbortSignal) => {
        onToken('我正在说一句话。');
        await gate;
        // 模拟真 Provider:abort 后抛 AbortError
        if (signal?.aborted === true) {
          const e = new Error('aborted');
          e.name = 'AbortError';
          throw e;
        }
        return '我正在说一句话。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(loop, transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 打断 → abort
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();
    expect(loop.state).toBe('listening');

    // 放行被卡的 send:它将以 AbortError reject —— 不应改变已回到的 listening 态、不崩
    release();
    await flush();
    expect(loop.state).toBe('listening');
  });

  it('④ 真取消(TTS)：barge-in 打断时本回合 tts.synthesize 收到的 signal 变 aborted', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 记录所收 signal 的 fake TTS：synthesize(text, opts?, signal?) 捕获 signal,
    // 每 chunk 前自检 signal?.aborted 干净结束(类比 FakeLlm.stream 的自检停产)。
    let capturedTtsSignal: AbortSignal | undefined;
    let ttsAbortedFired = false;
    const recordingTts: TtsProvider = {
      id: 'recording-tts',
      capabilities: { languages: ['*'], sampleRate: SAMPLE_RATE_HZ, streaming: true },
      async *synthesize(_text: string, _opts?: TtsOptions, signal?: AbortSignal): AsyncIterable<PcmChunk> {
        capturedTtsSignal = signal;
        signal?.addEventListener('abort', () => {
          ttsAbortedFired = true;
        });
        // 吐两块,每块前自检 aborted;首块触发 thinking→speaking。
        for (let i = 0; i < 2; i++) {
          if (signal?.aborted === true) return; // 真取消:停止后续合成
          yield { samples: new Int16Array(8), sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS };
        }
      },
    };
    // send：捕获本回合 signal,卡住直到打断,以证 TTS 与 LLM 共用同一回合 signal。
    let capturedSendSignal: AbortSignal | undefined;
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      tts: recordingTts,
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      send: async (_t, onToken, signal?: AbortSignal) => {
        capturedSendSignal = signal;
        onToken('我正在说一句话。'); // 整句 → 触发 #speak → tts.synthesize 拿到 signal
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(loop, transport);
    await flush();
    expect(loop.state).toBe('speaking');
    // TTS 拿到了一个未取消的 signal,且与 send 侧是同一回合的同一实例
    expect(capturedTtsSignal).toBeInstanceOf(AbortSignal);
    expect(capturedTtsSignal?.aborted).toBe(false);
    expect(capturedTtsSignal).toBe(capturedSendSignal); // TTS 与 LLM 共用同一回合 signal

    // 打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();

    // 真取消:本回合 TTS signal 已 aborted(底层合成会真停,不再后台跑完)
    expect(capturedTtsSignal?.aborted).toBe(true);
    expect(ttsAbortedFired).toBe(true);
    expect(loop.state).toBe('listening');

    release();
    await flush();
  });

  it('③ 降级：STT 空文本 → 回 listening 不崩', async () => {
    const { deps, transport } = makeDeps({
      stt: new FakeStt({ script: [{ text: '', isFinal: true }] }),
    });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(loop, transport);
    await flush();
    expect(loop.state).toBe('listening');
  });

  it('③ 降级：STT 抛错 → 回 listening 不崩', async () => {
    const throwingStt: SttProvider = {
      id: 'throwing',
      capabilities: { languages: ['*'], streaming: true, sampleRate: SAMPLE_RATE_HZ },
      // eslint-disable-next-line require-yield
      async *transcribe(): AsyncIterable<SttResult> {
        throw new Error('STT 引擎崩了');
      },
    };
    const { deps, transport } = makeDeps({ stt: throwingStt });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(loop, transport);
    await flush();
    expect(loop.state).toBe('listening');
  });
});
