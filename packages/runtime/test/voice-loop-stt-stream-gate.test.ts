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
import { StubVadDetector, TurnDetector, StubEouModel, DEFAULT_SPEECH_GATE_CONFIG, DEFAULT_FILLER_DENYLIST } from '@chat-a/voice-detect';
import { FakeStt, FakeTts } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

/** 16k mono Int16 上行帧,可控振幅(供段级能量累计判有声)。 */
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

function makeStreamDeps(over: Partial<VoiceLoopDeps> = {}): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0, 0, 0, 0, 0, 0, 0, 0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '（未用到）', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好呀。');
      return '你好呀。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's-gate',
    clock: () => 1000,
    voicePath: 'stt-stream',
    ...over,
  };
  return { deps, transport };
}

/** 推 n 帧(指定振幅)经 transport 上行(供段级能量累计)。 */
async function pushFrames(transport: InProcessAudioTransport, n: number, amp: number): Promise<void> {
  for (let i = 0; i < n; i++) transport.sendAudio(micFrameAmp(i * 10, amp));
  await flush();
}

describe('VoiceLoop stt-stream 防 ASR 静音/噪声幻觉(段能量 + 黑名单联合判伪)', () => {
  it('能量门显式开(streamEnergyGate=true)+ 低能量段 + onFinal("嗯") → gated(low-energy),不起回合', async () => {
    // 迁移自旧「纯能量门默认开」用例:能量门现默认关,断言 low-energy 须显式开门(opt-in 能力保留)。
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const traces: VoiceTraceEvent[] = [];
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      streamEnergyGate: true, // 显式开纯能量门
      voiceObserver: (ev) => traces.push(ev),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 10, 0); // 100ms 全静音(voiced 0)
    h.onSpeechStopped();
    h.onFinal('嗯');
    await flush();

    expect(sendSpy).not.toHaveBeenCalled();
    expect(loop.state).toBe('listening');
    const gated = traces.find((t) => t.kind === 'turn' && t.outcome === 'gated') as any;
    expect(gated).toBeTruthy();
    expect(gated.reason).toBe('low-energy');
  });

  it('能量门显式开 + 低能量段 + 内容词 final("十点。",非黑名单)→ gated(low-energy)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('好的。');
      return '好的。';
    });
    const traces: VoiceTraceEvent[] = [];
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      streamEnergyGate: true,
      voiceObserver: (ev) => traces.push(ev),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 102, 0); // ~1020ms 全静音(voiced 0)
    h.onSpeechStopped();
    h.onFinal('十点。');
    await flush();

    expect(sendSpy).not.toHaveBeenCalled();
    const gated = traces.find((t) => t.kind === 'turn' && t.outcome === 'gated') as any;
    expect(gated?.reason).toBe('low-energy');
  });

  it('回归:能量门默认关 + 低能量段(voiced=0)+ 内容词 final("十点。",非黑名单)→ 放行起回合(不误杀真话)', async () => {
    // 真机蓝牙 HFP 麦放音期本地能量失真:qwen 真转写出内容词「十点。」但段快照 voiced=0。
    // 纯能量门默认关 → 不再被 low-energy 误杀;黑名单不命中「十点。」→ 放行。
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('好的。');
      return '好的。';
    });
    const traces: VoiceTraceEvent[] = [];
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      // streamEnergyGate 不注入 → 默认关
      voiceObserver: (ev) => traces.push(ev),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 102, 0); // ~1020ms 段快照 voiced=0(本地能量失真)
    h.onSpeechStopped();
    h.onFinal('十点。'); // 真内容词,非黑名单
    await flush();

    expect(sendSpy).toHaveBeenCalledTimes(1); // 放行起回合
    const gated = traces.find((t) => t.kind === 'turn' && t.outcome === 'gated') as any;
    expect(gated).toBeFalsy(); // 不再 low-energy 误杀
  });

  it('回归:能量门默认关 + 低能量段(voiced=0)+ 黑名单词 final("嗯") → 仍 gated(denylist)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const traces: VoiceTraceEvent[] = [];
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      // 能量门默认关:黑名单仍是默认主防御
      voiceObserver: (ev) => traces.push(ev),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 10, 0); // voiced 0
    h.onSpeechStopped();
    h.onFinal('嗯');
    await flush();

    expect(sendSpy).not.toHaveBeenCalled();
    const gated = traces.find((t) => t.kind === 'turn' && t.outcome === 'gated') as any;
    expect(gated?.reason).toBe('denylist');
  });

  it('真语音段(>100ms voiced)+ onFinal("嗯") → 起回合(真附和不误杀)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 32, 8000); // 320ms 全有声(voiced≈320ms ≥100,total≥300)
    h.onSpeechStopped();
    h.onFinal('嗯');
    await flush();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith('嗯', expect.any(Function), expect.anything(), undefined);
  });

  it('onFinal("嗯") 前无 speech_started(无段证据)→ 保守放行(起回合)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const { deps } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    // 直接 onFinal,无 onSpeechStarted/onSpeechStopped → 无快照 → 降级保守放行。
    fake.handlers()!.onFinal('嗯');
    await flush();

    expect(sendSpy).toHaveBeenCalledTimes(1); // 保守放行:起回合
  });

  it('长 final 含 "thank you" + 高能量 → 放行(不误杀长真语音)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('回应。');
      return '回应。';
    });
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 40, 8000); // 高能量长段
    h.onSpeechStopped();
    h.onFinal('thank you very much for everything you said');
    await flush();

    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('低能量段 + 命中黑名单(无 speechGate,隔离黑名单)→ gated(denylist)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const traces: VoiceTraceEvent[] = [];
    const { deps, transport } = makeStreamDeps({
      streamingStt: fake.port,
      send: sendSpy,
      // 无 speechGate:隔离黑名单(能量门关,只看黑名单+低能量合取)。
      fillerDenylist: DEFAULT_FILLER_DENYLIST,
      voiceObserver: (ev) => traces.push(ev),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 8, 0); // 低能量(voiced 0 < 100)
    h.onSpeechStopped();
    h.onFinal('谢谢观看');
    await flush();

    expect(sendSpy).not.toHaveBeenCalled();
    const gated = traces.find((t) => t.kind === 'turn' && t.outcome === 'gated') as any;
    expect(gated?.reason).toBe('denylist');
  });

  it('不注入黑名单/能量门 → 逐字现状(低能量"嗯"仍起回合,只剩空文本丢)', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void) => {
      onToken('你好呀。');
      return '你好呀。';
    });
    const { deps, transport } = makeStreamDeps({ streamingStt: fake.port, send: sendSpy });
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers()!;
    h.onSpeechStarted();
    await pushFrames(transport, 8, 0);
    h.onSpeechStopped();
    h.onFinal('嗯'); // 低能量黑名单词,但无门 → 放行
    await flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);

    // 空文本仍丢(现状)
    sendSpy.mockClear();
    fake.handlers()!.onFinal('   ');
    await flush();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});
