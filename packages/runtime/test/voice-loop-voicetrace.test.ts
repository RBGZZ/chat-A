/**
 * VoiceLoop 语音可追溯 emit 测试（voice-traceability-design §4/§7/§9）。
 *
 * 注入 fake `voiceObserver`(收集 VoiceTraceEvent 数组),驱动各路径断言关键 emit:
 *  ① 段级语音门丢弃路 → `speech-gate passed:false` + `turn outcome:'gated'`;
 *  ② stt-stream onFinal → `stt-result` + `turn outcome:'replied'`(并验 `state` 迁移);
 *  ③ state 迁移 → 收到 `kind:'state'`;
 *  ④ 不注入 voiceObserver → 无 emit、行为逐字现状(与注入时下行 TTS 一致)。
 *  ⑤ mic-sample 节流(每 ~50 帧一次)。
 *
 * 脚手架照 `voice-loop-stt-stream.test.ts` / `voice-loop-speech-gate.test.ts` 复制。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
  type VoiceTraceEvent,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel, DEFAULT_SPEECH_GATE_CONFIG } from '@chat-a/voice-detect';
import { FakeTts } from '@chat-a/providers';
import type { SttEmotion, SttResult, SttProvider } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

// ───────────────────────────── 夹具 ─────────────────────────────

/** 16k mono Int16 上行 audio:input AudioFrame(可控振幅,供段级门按 RMS 判有声)。 */
function micFrameAmp(timestampMs: number, amp: number): AudioFrame {
  const samples = new Int16Array(160); // 10ms @16k
  samples.fill(amp);
  const pcm: PcmFrame = { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 收下行 tts:chunk 帧。 */
function downRecorder(transport: InProcessAudioTransport): AudioFrame[] {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  return down;
}

/** 记录 transcribe 调用次数的 fake STT。 */
function countingStt(): { stt: SttProvider; calls: () => number } {
  let n = 0;
  const stt: SttProvider = {
    id: 'counting',
    capabilities: { languages: ['*'], streaming: true, sampleRate: SAMPLE_RATE_HZ },
    async *transcribe(): AsyncIterable<SttResult> {
      n += 1;
      yield { text: '你好小雪', isFinal: true };
    },
  };
  return { stt, calls: () => n };
}

/** 注入式 fake StreamingSttPort:捕获 handlers。 */
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

/** 收集 voiceObserver 抛出的事件。 */
function makeObserver(): { observer: (ev: VoiceTraceEvent) => void; events: VoiceTraceEvent[] } {
  const events: VoiceTraceEvent[] = [];
  return { observer: (ev) => events.push(ev), events };
}

function baseDeps(over: Partial<VoiceLoopDeps>): {
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
    stt: countingStt().stt,
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_t, onToken) => {
      onToken('你好。');
      return '你好。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's-vtrace',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport, bus };
}

/** 短伪段:全 0 振幅(无有声内容)+ 长静音跳点制造 endpoint。 */
async function driveShortSilent(transport: InProcessAudioTransport): Promise<void> {
  for (let t = 0; t <= 50; t += 10) transport.sendAudio(micFrameAmp(t, 0));
  transport.sendAudio(micFrameAmp(10_050, 0)); // 大跳时间戳 → 长静音 → endpoint
  await flush();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('VoiceLoop 语音可追溯 emit', () => {
  it('① 段级语音门丢弃 → speech-gate passed:false + turn outcome:gated', async () => {
    const { observer, events } = makeObserver();
    const { stt } = countingStt();
    const { deps, transport } = baseDeps({
      stt,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      voiceObserver: observer,
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveShortSilent(transport);
    await flush();

    const gate = events.find((e) => e.kind === 'speech-gate');
    expect(gate).toBeDefined();
    expect(gate).toMatchObject({ kind: 'speech-gate', passed: false });
    // gated 回合 emit
    expect(events.some((e) => e.kind === 'turn' && e.outcome === 'gated')).toBe(true);
    // 公共字段被中心化补全
    expect(gate?.sessionId).toBe('s-vtrace');
    expect(gate?.atMs).toBe(1000);
    expect(loop.state).toBe('listening');
  });

  it('② stt-stream onFinal → stt-result + turn outcome:replied + state 迁移', async () => {
    const { observer, events } = makeObserver();
    const fake = fakeStreamPort();
    const { deps, transport } = baseDeps({
      voicePath: 'stt-stream',
      streamingStt: fake.port,
      voiceObserver: observer,
      send: async (_t, onToken) => {
        onToken('好呀，阳光暖暖的。');
        return '好呀，阳光暖暖的。';
      },
    });
    const down = downRecorder(transport);
    const loop = new VoiceLoop(deps);
    loop.start();

    const emotion: SttEmotion = { label: 'happy' };
    fake.handlers()!.onFinal('你好世界', emotion, 'zh');
    await flush();

    // stt-result 带定稿文本/情绪/语种
    const res = events.find((e) => e.kind === 'stt-result');
    expect(res).toMatchObject({ kind: 'stt-result', text: '你好世界', isFinal: true, emotion: 'happy', lang: 'zh' });
    // stt-input(流式 path)
    expect(events.some((e) => e.kind === 'stt-input' && e.path === 'stt-stream')).toBe(true);
    // 正常回合收尾
    expect(events.some((e) => e.kind === 'turn' && e.outcome === 'replied')).toBe(true);
    // ③ state 迁移有 emit
    expect(events.some((e) => e.kind === 'state')).toBe(true);
    // 行为:走 TTS 下行
    expect(down.length).toBeGreaterThan(0);
  });

  it('③ state 迁移逐次 emit(listening→endpointing→thinking→speaking→listening)', async () => {
    const { observer, events } = makeObserver();
    const fake = fakeStreamPort();
    const { deps } = baseDeps({
      voicePath: 'stt-stream',
      streamingStt: fake.port,
      voiceObserver: observer,
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    fake.handlers()!.onFinal('你好');
    await flush();

    const transitions = events
      .filter((e): e is Extract<VoiceTraceEvent, { kind: 'state' }> => e.kind === 'state')
      .map((e) => `${e.from}->${e.to}`);
    expect(transitions).toContain('listening->endpointing');
    expect(transitions).toContain('endpointing->thinking');
    expect(transitions).toContain('thinking->speaking');
    expect(transitions).toContain('speaking->listening');
  });

  it('④ 不注入 voiceObserver → 无 emit、行为与注入时逐字一致', async () => {
    // 注入观测的对照组(取下行帧数作为「行为」基线)。
    const { observer } = makeObserver();
    const fakeA = fakeStreamPort();
    const a = baseDeps({ voicePath: 'stt-stream', streamingStt: fakeA.port, voiceObserver: observer });
    const downA = downRecorder(a.transport);
    const loopA = new VoiceLoop(a.deps);
    loopA.start();
    fakeA.handlers()!.onFinal('你好');
    await flush();

    // 不注入观测组:行为应逐字一致(下行帧数相同),且无任何可观测副作用。
    const fakeB = fakeStreamPort();
    const b = baseDeps({ voicePath: 'stt-stream', streamingStt: fakeB.port }); // 无 voiceObserver
    const downB = downRecorder(b.transport);
    const loopB = new VoiceLoop(b.deps);
    loopB.start();
    fakeB.handlers()!.onFinal('你好');
    await flush();

    expect(downB.length).toBe(downA.length); // 行为逐字一致
    expect(downB.length).toBeGreaterThan(0);
    expect(loopB.state).toBe('listening');
  });

  it('⑤ mic-sample 节流:listening 期每 ~50 帧采样一次', async () => {
    const { observer, events } = makeObserver();
    // VAD 恒静音(probs 用完即 0)→ 不触发 speech_start,保持 listening,仅 mic-sample 节流采样。
    const { deps, transport } = baseDeps({ vad: new StubVadDetector([0]), voiceObserver: observer });
    const loop = new VoiceLoop(deps);
    loop.start();

    for (let i = 0; i < 100; i++) transport.sendAudio(micFrameAmp(i * 10, 0));
    await flush();

    const mic = events.filter((e) => e.kind === 'mic-sample');
    expect(mic.length).toBe(2); // 第 0、50 帧各一次(100 帧 / 50)
    expect(loop.state).toBe('listening');
  });
});
