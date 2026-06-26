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
import type { SttProvider, SttResult, SttCapabilities } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type {
  VoiceLoopDeps,
  StreamingSttPort,
  StreamingSttHandlers,
  StreamingSttSession,
} from '../src/voice-loop';

// ───────────────────────────── 测试夹具 ─────────────────────────────

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

/** 放行所有挂起微任务(FakeStt/FakeTts/send 同步即时,多轮跑透链式 await)。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

/** 驱动一段「语音 4 帧 → 长静音」(带基准时刻偏移,可多次驱动)。 */
function driveSpeechThenSilence(transport: InProcessAudioTransport, base: number): void {
  transport.sendAudio(micFrame(base + 0));
  transport.sendAudio(micFrame(base + 10));
  transport.sendAudio(micFrame(base + 20));
  transport.sendAudio(micFrame(base + 30));
  transport.sendAudio(micFrame(base + 40));
  transport.sendAudio(micFrame(base + 50));
  transport.sendAudio(micFrame(base + 10_050)); // 大跳静音 → silenceMs ≫ 阈值,必 EOU
}

const CAPS: SttCapabilities = { languages: ['*'], streaming: true, sampleRate: SAMPLE_RATE_HZ };

// ───────────────────────────── 批式路:单回合守卫 ─────────────────────────────

describe('VoiceLoop 回合并发竞态修复', () => {
  it('批式路:转写在途时并发 endpoint 不起第二个回合,最终不卡 thinking', async () => {
    const transport = new InProcessAudioTransport();
    const bus = new LightVoiceBus();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let transcribeCalls = 0;
    const stt: SttProvider = {
      id: 'gated',
      capabilities: CAPS,
      async *transcribe(): AsyncIterable<SttResult> {
        transcribeCalls += 1;
        await gate; // 卡住转写,模拟「在途」期间的重入窗
        yield { text: '你好小雪', isFinal: true };
      },
    };
    const sendSpy = vi.fn(async (_t: string, onToken: (s: string) => void): Promise<string> => {
      onToken('你好。');
      return '你好。';
    });
    const deps: VoiceLoopDeps = {
      transport,
      // 两段「高×4 低×3」概率(StubVadDetector 不循环,需覆盖 14 帧)。
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0, 0, 0, 0.9, 0.9, 0.9, 0.9, 0, 0, 0]),
      turnDetector: new TurnDetector(new StubEouModel([0.9])),
      stt,
      tts: new FakeTts({ samplesPerChar: 4 }),
      send: sendSpy,
      memory: { appendMessage: vi.fn() },
      bus,
      sessionId: 's-cc',
      clock: () => 1000,
    };
    const loop = new VoiceLoop(deps);
    loop.start();

    // 第一段:EOU → 进入转写在途(committing)。
    driveSpeechThenSilence(transport, 0);
    await flush();
    expect(transcribeCalls).toBe(1);
    expect(loop.state).not.toBe('listening'); // 已离开 listening(转写在途)

    // 转写仍在途时再来一段:单回合守卫应拒绝第二个回合(不并发起第二次转写)。
    driveSpeechThenSilence(transport, 20_000);
    await flush();
    expect(transcribeCalls).toBe(1); // 关键断言:绝不并发第二个转写/回合

    // 放行转写 → 回合干净推进到底,最终回 listening,绝不卡死在 thinking。
    release();
    await flush();
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(loop.state).toBe('listening');
  });

  // ───────────────────────────── 流式路:超越必取消 ─────────────────────────────

  it('流式路:连续两个 onFinal,旧回合被真 abort,新句不被静默丢弃,最终态合法', async () => {
    let handlers: StreamingSttHandlers | null = null;
    const port: StreamingSttPort = {
      openSession(h): StreamingSttSession {
        handlers = h;
        return { pushAudio: () => {}, close: () => {} };
      },
    };

    let signal1: AbortSignal | undefined;
    let callCount = 0;
    const sendSpy = vi.fn(
      async (text: string, onToken: (s: string) => void, signal?: AbortSignal): Promise<string> => {
        callCount += 1;
        if (callCount === 1) {
          signal1 = signal;
          // 第一回合卡住等待:被 abort(真打断)即 reject,模拟真实 LLM 流真停。
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          });
          onToken('一。');
          return '一。';
        }
        onToken('二。');
        return '二。';
      },
    );

    const transport = new InProcessAudioTransport();
    const bus = new LightVoiceBus();
    const deps: VoiceLoopDeps = {
      transport,
      vad: new StubVadDetector([0, 0, 0, 0]),
      turnDetector: new TurnDetector(new StubEouModel([0.9])),
      stt: new FakeStt({ script: [{ text: '(未用)', isFinal: true }] }),
      tts: new FakeTts({ samplesPerChar: 4 }),
      send: sendSpy,
      memory: { appendMessage: vi.fn() },
      bus,
      sessionId: 's-stream-cc',
      clock: () => 1000,
      voicePath: 'stt-stream',
      streamingStt: port,
    };
    const loop = new VoiceLoop(deps);
    loop.start();

    handlers!.onFinal('第一句');
    await flush();
    expect(callCount).toBe(1);
    expect(signal1).toBeDefined();
    expect(signal1!.aborted).toBe(false); // 旧回合在途,尚未被取消

    // 第二句快速到达 → 超越:旧回合必被 abort,新句必被处理(不静默丢弃)。
    handlers!.onFinal('第二句');
    await flush();
    expect(signal1!.aborted).toBe(true); // 关键:旧回合 signal 真 abort
    expect(callCount).toBe(2); // 关键:新句被处理,未被静默丢弃
    expect(sendSpy.mock.calls[1]![0]).toBe('第二句');

    await flush();
    expect(['listening', 'speaking']).toContain(loop.state); // 最终态合法
  });
});
