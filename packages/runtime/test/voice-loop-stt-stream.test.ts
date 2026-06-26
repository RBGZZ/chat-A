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
import { FakeStt, FakeTts } from '@chat-a/providers';
import type { SttEmotion } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

// ───────────────────────────── 测试夹具（照 voice-loop.test.ts 脚手架）─────────────────────────────

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

/** 放行所有挂起的微任务/Promise（FakeStt/FakeTts/send 均同步即时,多轮确保链式 await 跑透）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 收下行 tts:chunk 帧的记录器。 */
function downRecorder(transport: InProcessAudioTransport): AudioFrame[] {
  const down: AudioFrame[] = [];
  transport.onAudio((f) => {
    if (f.type === 'tts:chunk') down.push(f);
  });
  return down;
}

/** 注入式 fake StreamingSttPort:捕获 handlers,记录 pushAudio。 */
function fakeStreamPort(): {
  port: StreamingSttPort;
  handlers(): StreamingSttHandlers | null;
  pushed: unknown[];
  openCount(): number;
  closeCount(): number;
} {
  let handlers: StreamingSttHandlers | null = null;
  let openCount = 0;
  let closeCount = 0;
  const pushed: unknown[] = [];
  const port: StreamingSttPort = {
    openSession(h): StreamingSttSession {
      openCount += 1;
      handlers = h;
      return {
        pushAudio: (c) => pushed.push(c),
        close: () => {
          closeCount += 1;
        },
      };
    },
  };
  return { port, handlers: () => handlers, pushed, openCount: () => openCount, closeCount: () => closeCount };
}

/** 组装 stt-stream 路 deps（VAD 默认全静音概率 → 不自驱动批式回合,纯由 onFinal 驱动）。 */
function makeStreamDeps(
  over: Partial<VoiceLoopDeps> = {},
  vadProbs: readonly number[] = [0, 0, 0, 0, 0, 0, 0, 0],
): { deps: VoiceLoopDeps; transport: InProcessAudioTransport; bus: LightVoiceBus } {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector(vadProbs),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt: new FakeStt({ script: [{ text: '（未用到）', isFinal: true }] }),
    tts: new FakeTts({ samplesPerChar: 4 }),
    send: async (_text, onToken) => {
      onToken('你好呀。');
      return '你好呀。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's-stream',
    clock: () => 1000,
    voicePath: 'stt-stream',
    ...over,
  };
  return { deps, transport, bus };
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('VoiceLoop 连续流式路 (stt-stream)', () => {
  it('(a) onFinal(text,emotion) → #send 以 (text, onToken, signal, emotion) 被调且走 TTS', async () => {
    const fake = fakeStreamPort();
    const sendSpy = vi.fn(
      async (_text: string, onToken: (t: string) => void): Promise<string> => {
        onToken('好呀，阳光暖暖的。'); // 含句末标点 → 切句 → 喂 TTS
        return '好呀，阳光暖暖的。';
      },
    );
    const { deps, transport } = makeStreamDeps({ streamingStt: fake.port, send: sendSpy });
    const down = downRecorder(transport);
    const loop = new VoiceLoop(deps);
    loop.start();

    expect(fake.openCount()).toBe(1); // start() 即开会话
    expect(fake.handlers()).not.toBeNull();

    const emotion: SttEmotion = { label: 'happy' };
    fake.handlers()!.onFinal('你好世界', emotion);
    await flush();

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy).toHaveBeenCalledWith(
      '你好世界',
      expect.any(Function),
      expect.anything(), // AbortSignal
      { label: 'happy' },
    );
    // 走 TTS：下行收到 tts:chunk 帧 + 进入过 speaking
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((f) => f.type === 'tts:chunk')).toBe(true);
  });

  it('(b) start() 后 openSession 被调；listening 态 audio:input 帧经 pushAudio 推出', async () => {
    const fake = fakeStreamPort();
    const { deps, transport } = makeStreamDeps({ streamingStt: fake.port });
    const loop = new VoiceLoop(deps);
    loop.start();

    expect(fake.openCount()).toBe(1);
    expect(loop.state).toBe('listening');

    transport.sendAudio(micFrame(0));
    transport.sendAudio(micFrame(10));
    await flush();

    expect(fake.pushed.length).toBe(2); // 两帧均在 listening 态推出
    // 推出的是 PcmChunk(samples/sampleRate/channels)
    const first = fake.pushed[0] as { samples: Int16Array; sampleRate: number; channels: number };
    expect(first.sampleRate).toBe(SAMPLE_RATE_HZ);
    expect(first.channels).toBe(CHANNELS);
    expect(first.samples).toBeInstanceOf(Int16Array);
  });

  it('(c) speaking 态(已起回合) audio:input → 不推流(pushed 数不增)', async () => {
    const fake = fakeStreamPort();
    // send 卡在闸门:先吐一句触发 speaking,再 await gate 把回合停在 speaking。
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const sendSpy = vi.fn(
      async (_text: string, onToken: (t: string) => void): Promise<string> => {
        onToken('我正在说一句话。'); // 切出整句 → 触发 thinking→speaking
        await gate; // 卡住:回合停在 speaking
        return '我正在说一句话。';
      },
    );
    // VAD 全静音概率:speaking 期来帧不会触发 barge-in(只验「不推流」)。
    const { deps, transport } = makeStreamDeps({ streamingStt: fake.port, send: sendSpy });
    const loop = new VoiceLoop(deps);
    loop.start();

    fake.handlers()!.onFinal('开始说话');
    await flush();
    expect(loop.state).toBe('speaking'); // 回合停在 speaking(send 卡 gate)

    const before = fake.pushed.length;
    transport.sendAudio(micFrame(0));
    transport.sendAudio(micFrame(10));
    await flush();

    expect(fake.pushed.length).toBe(before); // speaking 态不推流
    expect(loop.state).toBe('speaking'); // 仍 speaking,未被打断

    release();
    await flush();
  });

  it('(d) stop() 关闭流式会话', () => {
    const fake = fakeStreamPort();
    const { deps } = makeStreamDeps({ streamingStt: fake.port });
    const loop = new VoiceLoop(deps);
    loop.start();
    expect(fake.openCount()).toBe(1);
    loop.stop();
    expect(fake.closeCount()).toBe(1);
  });
});
