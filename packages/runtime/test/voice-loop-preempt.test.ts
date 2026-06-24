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
import type { VoiceLoopDeps, VoiceLoopAttentionConfig } from '../src/voice-loop';

/**
 * 缝 1 + 缝 2 单测(不触网):VoiceLoop 暴露 isSpeaking/speakState + requestAutonomyPreempt 真打断。
 * 复用既有夹具范式(StubVad/FakeStt/FakeTts + 注入时钟),驱动到 speaking 后断言。
 */

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

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** send 先吐一句触发 speaking,再卡门(模拟在飞 autonomy 输出未说完)。 */
function makeDeps(
  attention?: VoiceLoopAttentionConfig,
): {
  deps: VoiceLoopDeps;
  transport: InProcessAudioTransport;
  bus: LightVoiceBus;
  mem: ReturnType<typeof fakeMemory>;
  events: BusEvent[];
  release: () => void;
} {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const mem = fakeMemory();
  const events: BusEvent[] = [];
  bus.onAny((e) => events.push(e));
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '你好小雪', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_t, onToken) => {
      onToken('我正在主动说一句话。');
      await gate;
      onToken('后面还没说完。');
      return '我正在主动说一句话。后面还没说完。';
    },
    memory: { appendMessage: mem.appendMessage },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...(attention ? { attention } : {}),
  };
  return { deps, transport, bus, mem, events, release };
}

async function driveToSpeaking(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrame(0));
  transport.sendAudio(micFrame(10));
  transport.sendAudio(micFrame(20));
  transport.sendAudio(micFrame(30));
  transport.sendAudio(micFrame(40));
  transport.sendAudio(micFrame(50));
  transport.sendAudio(micFrame(10_050));
  await flush();
}

describe('runtime/VoiceLoop isSpeaking + speakState(缝 2)', () => {
  it('listening 态 isSpeaking=false;speaking 态 isSpeaking=true', async () => {
    const { deps, transport, release } = makeDeps();
    const loop = new VoiceLoop(deps);
    loop.start();
    expect(loop.isSpeaking).toBe(false);
    expect(loop.speakState()).toEqual({ isSpeaking: false });

    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');
    expect(loop.isSpeaking).toBe(true);
    expect(loop.speakState()).toEqual({ isSpeaking: true });
    release();
    await flush();
  });
});

describe('runtime/VoiceLoop requestAutonomyPreempt(缝 1:autonomy 真打断)', () => {
  it('非 speaking → 返回 false、无副作用', async () => {
    const { deps, mem, events } = makeDeps();
    const loop = new VoiceLoop(deps);
    loop.start();
    expect(loop.state).toBe('listening');
    const r = loop.requestAutonomyPreempt('autonomy_preempt');
    expect(r).toBe(false);
    expect(loop.state).toBe('listening');
    expect(mem.appendMessage).not.toHaveBeenCalled();
    expect(events.some((e) => e.action === 'turn:interrupt')).toBe(false);
  });

  it('speaking + 无关注闸 → 真打断回 listening + turn:interrupt(autonomy_preempt) + 半句写回', async () => {
    const { deps, transport, mem, events, release } = makeDeps();
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    const r = loop.requestAutonomyPreempt('autonomy_preempt');
    await flush();
    expect(r).toBe(true);
    expect(loop.state).toBe('listening');
    // 半句写回(标 interrupted)
    expect(mem.appendMessage).toHaveBeenCalled();
    const written = mem.calls[0] as { role: string; turnId: string; content: string };
    expect(written.turnId).toBe('interrupted');
    expect(written.content).toContain('[被用户打断]');
    expect(written.content).toContain('我正在主动说一句话。');
    // turn:interrupt 的 reason 为 autonomy_preempt(区分于用户 barge_in)
    const ev = events.find((e) => e.action === 'turn:interrupt') as
      | (BusEvent & { data: { reason: string } })
      | undefined;
    expect(ev?.data.reason).toBe('autonomy_preempt');
    release();
    await flush();
  });

  it('speaking + focus 关注闸(sustainedMs=0)→ 不打断(autonomy 不轻易打断自己专注输出)', async () => {
    const { deps, transport, release } = makeDeps({ mode: 'focus' });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    const r = loop.requestAutonomyPreempt('autonomy_preempt');
    await flush();
    expect(r).toBe(false);
    expect(loop.state).toBe('speaking'); // focus 未达坚持门槛 → 不打断
    release();
    await flush();
  });

  it('speaking + companion 关注闸 → 打断', async () => {
    const { deps, transport, release } = makeDeps({ mode: 'companion' });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveToSpeaking(transport);
    expect(loop.state).toBe('speaking');

    const r = loop.requestAutonomyPreempt('autonomy_preempt');
    await flush();
    expect(r).toBe(true);
    expect(loop.state).toBe('listening');
    release();
    await flush();
  });
});
