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
import { FakeStt } from '@chat-a/providers';
import type { TtsProvider, TtsCapabilities, PcmChunk } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';
import { DEFAULT_BACKCHANNEL_CONFIG } from '../src/backchannel-controller';

// ───────────────────────────── 测试夹具（照 voice-loop-stt-stream.test.ts 脚手架）─────────────────────────────

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

/** 放行所有挂起的微任务/Promise（FakeStt/fakeTts/send 均同步即时,多轮确保链式 await 跑透）。 */
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
} {
  let handlers: StreamingSttHandlers | null = null;
  const pushed: unknown[] = [];
  const port: StreamingSttPort = {
    openSession(h): StreamingSttSession {
      handlers = h;
      return {
        pushAudio: (c) => pushed.push(c),
        close: () => {},
      };
    },
  };
  return { port, handlers: () => handlers, pushed };
}

/**
 * fake TtsProvider:记录每次 synthesize 的文本,yield 一个固定时长的 chunk。
 * 4800 样本 @16k = 300ms → backchannel 门控窗 = now + 300 + 200 = now + 500。
 */
function fakeTts(): { tts: TtsProvider; calls: string[]; chunkDurMs: number } {
  const calls: string[] = [];
  const samples = 4800; // 300ms @16k
  const capabilities: TtsCapabilities = {
    languages: ['*'],
    voiceId: ['fake'],
    sampleRate: SAMPLE_RATE_HZ,
    streaming: true,
    voiceCloning: true,
  };
  const tts: TtsProvider = {
    id: 'fake-bc',
    capabilities,
    // eslint-disable-next-line @typescript-eslint/require-await
    async *synthesize(text: string): AsyncIterable<PcmChunk> {
      calls.push(text);
      yield { samples: new Int16Array(samples), sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS };
    },
  };
  return { tts, calls, chunkDurMs: (samples / SAMPLE_RATE_HZ) * 1000 };
}

// ───────────────────────────── 测试 ─────────────────────────────

describe('VoiceLoop backchannel (stt-stream)', () => {
  it('说话中停顿 → 播附和 clip(经fake tts)、不占回合(不调send)、播放期门控上行', async () => {
    const fake = fakeStreamPort();
    const { tts, calls } = fakeTts();
    const sendSpy = vi.fn(async (): Promise<string> => '（不该被调）');
    // 注入可控时钟（VoiceLoop 已支持 deps.clock）：backchannel 全程读此 now。
    let clockNow = 0;
    const transport = new InProcessAudioTransport();
    const bus = new LightVoiceBus();
    const deps: VoiceLoopDeps = {
      transport,
      vad: new StubVadDetector([0, 0, 0, 0, 0, 0, 0, 0]), // 全静音概率 → 不自驱动批式回合/打断
      turnDetector: new TurnDetector(new StubEouModel([0.9])),
      stt: new FakeStt({ script: [{ text: '（未用到）', isFinal: true }] }),
      tts,
      send: sendSpy,
      memory: { appendMessage: vi.fn() },
      bus,
      sessionId: 's-bc',
      clock: () => clockNow,
      voicePath: 'stt-stream',
      streamingStt: fake.port,
      backchannel: DEFAULT_BACKCHANNEL_CONFIG, // pause700 minSpeech3000 cooldown5000 clips[嗯,...]
    };
    const down = downRecorder(transport);
    const loop = new VoiceLoop(deps);
    loop.start();

    const h = fake.handlers();
    expect(h).not.toBeNull();

    // 用户开口@0、最近 partial@100：speechStartedAtMs=0, lastPartialAtMs=100。
    clockNow = 0;
    h!.onSpeechStarted();
    clockNow = 100;
    h!.onPartial('我');

    // 喂一帧并把时钟推到 3200：spoken=3200≥3000, sincePartial=3100≥700, 首次冷却=∞ → 命中附和。
    const before = fake.pushed.length; // 0（开口/partial 不推流）
    clockNow = 3200;
    transport.sendAudio(micFrame(3200));
    await flush();

    // ① 命中：fakeTts 以 clipText('嗯', clipIndex 0) 被调 + 下行有附和帧。
    expect(calls).toContain('嗯');
    expect(down.length).toBeGreaterThan(0);
    expect(down.every((f) => f.type === 'tts:chunk')).toBe(true);

    // ② 不占回合：send 未被调用；状态仍 listening（不进 thinking/speaking 状态机）。
    expect(sendSpy).not.toHaveBeenCalled();
    expect(loop.state).toBe('listening');

    // 命中帧本身（now=3200≥门控0）仍推流：afterFire = before + 1。
    const afterFire = fake.pushed.length;
    expect(afterFire).toBe(before + 1);
    // 门控窗 = 3200 + 300 + 200 = 3700。

    // ③a 门控窗内（now=3300<3700）：pushAudio 不增。
    clockNow = 3300;
    transport.sendAudio(micFrame(3300));
    await flush();
    expect(fake.pushed.length).toBe(afterFire);

    // ③b 门控窗后（now=3800≥3700）：pushAudio 恢复。
    clockNow = 3800;
    transport.sendAudio(micFrame(3800));
    await flush();
    expect(fake.pushed.length).toBe(afterFire + 1);

    // 冷却内（sinceBc<5000）不重复附和：synthesize 仍只 1 次。
    expect(calls.length).toBe(1);
  });
});
