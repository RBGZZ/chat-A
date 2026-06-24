/**
 * EchoGuard(自打断防护)集成测试:验证 speaking 期连续 N 帧去抖压回声、真人仍打得断、
 * 非说话期灵敏度不变、危机/硬打断豁免。全程确定性 Stub VAD,不触网。
 *
 * 回归硬线另见 voice-loop.test.ts(未注入 EchoGuard 即现状,本文件不重复)。
 */
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
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps } from '../src/voice-loop';

function micFrame(timestampMs: number): AudioFrame {
  const pcm: PcmFrame = {
    samples: new Int16Array(160),
    sampleRate: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    timestampMs,
  };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

function fakeMemory(): { appendMessage: ReturnType<typeof vi.fn>; calls: unknown[] } {
  const calls: unknown[] = [];
  const appendMessage = vi.fn((m: unknown) => {
    calls.push(m);
  });
  return { appendMessage, calls };
}

function recorders(transport: InProcessAudioTransport, bus: LightVoiceBus) {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  const events: BusEvent[] = [];
  bus.onAny((e) => events.push(e));
  return { down, events };
}

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

async function driveSpeechThenSilence(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  transport.sendAudio(micFrame(10_050));
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('runtime/VoiceLoop EchoGuard 自打断防护', () => {
  it('说话期回声样式(断续,连续达标不足 N)被压制:不打断、不 clearBuffer、不写半句', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 索引 0~6:driveSpeechThenSilence(4 有声 + 3 静音);
    // 7~14:speaking 期断续回声样式(高-低-高-低...),连续达标永不足 N=3。
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.0, 0.9, 0.0, 0.9, 0.0, 0.9, 0.0]),
      echoGuard: { enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 },
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        return '我正在说一句话。';
      },
    });
    const { down } = recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');
    const downBefore = down.length;

    // 断续回声帧序列(高-低交替,VAD 因 2 帧去抖根本进不了 speech_start;即便算高置信也不连续 3 帧)
    for (let i = 0; i < 8; i++) {
      transport.sendAudio(micFrame(20_000 + i * 10));
    }
    await flush();

    // 未被打断:仍在 speaking,无 clearBuffer,无半句写回
    expect(loop.state).toBe('speaking');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(mem.appendMessage).not.toHaveBeenCalled();
    expect(down.length).toBe(downBefore);

    release();
    await flush();
  });

  it('真人连续 N 帧高置信仍能打断:回 listening + clearBuffer + 半句写回(证打得断)', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // 7~12:speaking 期连续 6 帧高置信(>=N=3)→ 必确认打断。
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
      echoGuard: { enabled: true, confirmFrames: 3, minSpeechProb: 0.5, minEnergy: 0 },
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 连续 6 帧高置信真语音
    for (let i = 0; i < 6; i++) {
      transport.sendAudio(micFrame(20_000 + i * 10));
    }
    await flush();

    expect(loop.state).toBe('listening'); // 打得断
    expect(clearSpy).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; content: string };
    expect(written.role).toBe('assistant');
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('非说话期灵敏度不变:注入 EchoGuard 后正常闭环仍走通(EchoGuard 只在 speaking 生效)', async () => {
    const { deps, transport, bus } = makeDeps({
      echoGuard: { enabled: true, confirmFrames: 5, minSpeechProb: 0.5, minEnergy: 0 },
    });
    const { down, events } = recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();

    // 正常闭环不受 EchoGuard 影响(端点检测在 listening/endpointing,EchoGuard 不参与)
    expect(loop.state).toBe('listening');
    const actions = events.map((e) => e.action).filter((a) => a !== 'turn:start');
    expect(actions).toEqual(['vad:speech_start', 'stt:final', 'tts:first_audio', 'turn:end']);
    expect(down.length).toBeGreaterThan(0);
  });

  it('危机/硬打断豁免:hardInterrupt 标注下单帧即打断(不被 N 帧拖延)', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      // 7~8:speaking 期两帧高置信触 speech_start;但 confirmFrames=10 远大于此 → 唯豁免才打断。
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
      echoGuard: { enabled: true, confirmFrames: 10, minSpeechProb: 0.5, minEnergy: 0 },
      // 注入 attention + buildSignal 恒标 hardInterrupt → 豁免去抖立即打断。
      attention: {
        mode: 'companion',
        buildSignal: () => ({ sustainedMs: 0, hardInterrupt: true }),
      },
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        onToken('后面还没说完。');
        return '我正在说一句话。后面还没说完。';
      },
    });
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 仅一帧:因 hardInterrupt 豁免绕过 N 帧去抖,首帧即打断(若无豁免,N=10 远不够)。
    // 只发一帧避免打断回 listening 后又被多余高帧带回 endpointing(那会掩盖「单帧即打断」的断言)。
    transport.sendAudio(micFrame(20_000));
    await flush();

    expect(loop.state).toBe('listening');
    const written = mem.calls[0] as { content: string };
    expect(written.content).toContain('[被用户打断]');

    release();
    await flush();
  });

  it('能量门:speaking 期连续帧 prob 达标但能量为 0 且 minEnergy>0 → 不打断', async () => {
    const mem = fakeMemory();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // micFrame 的 samples 全 0 → 能量 0;minEnergy=0.3 → 永不达标 → 压制。
    const { deps, transport, bus } = makeDeps({
      memory: { appendMessage: mem.appendMessage },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9, 0.9, 0.9, 0.9]),
      echoGuard: { enabled: true, confirmFrames: 2, minSpeechProb: 0.5, minEnergy: 0.3 },
      send: async (_t, onToken) => {
        onToken('我正在说一句话。');
        await gate;
        return '我正在说一句话。';
      },
    });
    const clearSpy = vi.spyOn(transport, 'clearBuffer');
    recorders(transport, bus);
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    for (let i = 0; i < 5; i++) transport.sendAudio(micFrame(20_000 + i * 10));
    await flush();

    // 能量恒 0 < 0.3 → EchoGuard 永不确认 → 不打断
    expect(loop.state).toBe('speaking');
    expect(clearSpy).not.toHaveBeenCalled();

    release();
    await flush();
  });
});
