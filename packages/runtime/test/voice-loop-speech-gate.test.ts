import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  SAMPLE_RATE_HZ,
  CHANNELS,
  type AudioFrame,
  type PcmFrame,
} from '@chat-a/protocol';
import { StubVadDetector, TurnDetector, StubEouModel, DEFAULT_SPEECH_GATE_CONFIG } from '@chat-a/voice-detect';
import { FakeTts } from '@chat-a/providers';
import type { SttResult, SttProvider } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps } from '../src/voice-loop';

/** 构造一个 16k mono Int16 上行 audio:input AudioFrame(可控振幅,供段级语音门按 RMS 判有声)。 */
function micFrameAmp(timestampMs: number, amp: number): AudioFrame {
  const samples = new Int16Array(160); // 10ms @16k
  samples.fill(amp);
  const pcm: PcmFrame = { samples, sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, timestampMs };
  return makeDataFrame('audio:input', {
    audio: pcm,
    format: { sampleRate: SAMPLE_RATE_HZ, channels: CHANNELS, sampleFormat: 's16le' },
  });
}

/** 记录 transcribe 调用次数的 fake STT(供断言「伪段未送 ASR」)。 */
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

function makeDeps(over: Partial<VoiceLoopDeps>): {
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
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport, bus };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** 短伪段:4 有声帧 + 3 静音帧(共 6 帧入 buf,60ms < 300ms),全 0 振幅(无有声内容)。 */
async function driveShortSilent(transport: InProcessAudioTransport): Promise<void> {
  transport.sendAudio(micFrameAmp(0, 0));
  transport.sendAudio(micFrameAmp(10, 0));
  transport.sendAudio(micFrameAmp(20, 0));
  transport.sendAudio(micFrameAmp(30, 0));
  transport.sendAudio(micFrameAmp(40, 0));
  transport.sendAudio(micFrameAmp(50, 0));
  transport.sendAudio(micFrameAmp(10_050, 0)); // 大跳时间戳制造长静音 → endpoint
  await flush();
}

/** 真语音段:32 高振幅有声帧 + 静音收尾 + 长静音跳点(buf≈34 帧、340ms、全有声)。 */
async function driveRealSpeech(transport: InProcessAudioTransport): Promise<void> {
  let t = 0;
  for (let i = 0; i < 32; i++) {
    transport.sendAudio(micFrameAmp(t, 8000)); // 归一 RMS ≈ 0.24 ≫ 0.02
    t += 10;
  }
  transport.sendAudio(micFrameAmp(t, 8000)); // prob 0.0 → belowRun 1
  t += 10;
  transport.sendAudio(micFrameAmp(t, 8000)); // prob 0.0 → speech_end
  transport.sendAudio(micFrameAmp(20_000, 8000)); // 长静音跳点 → endpoint
  await flush();
}

describe('runtime/VoiceLoop 段级语音门(防 ASR 静音幻觉 Layer 2)', () => {
  it('注入 gate + 伪段(过短/无有声)→ 不送 ASR、回 listening、不崩', async () => {
    const { stt, calls } = countingStt();
    const { deps, transport } = makeDeps({ stt, speechGate: DEFAULT_SPEECH_GATE_CONFIG });
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveShortSilent(transport);
    await flush();

    expect(calls()).toBe(0); // 伪段被段级门拦下,STT.transcribe 未被调用
    expect(loop.state).toBe('listening');
  });

  it('注入 gate + 足够长且有声 → 放行送 ASR、正常走回合', async () => {
    const { stt, calls } = countingStt();
    const { deps, transport } = makeDeps({
      stt,
      speechGate: DEFAULT_SPEECH_GATE_CONFIG,
      // 长有声序列:前 32 帧 0.9(speech_start + 持续),其后 0.0(speech_end + 静音)。
      vad: new StubVadDetector([...new Array(32).fill(0.9), 0.0, 0.0, 0.0]),
    });
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveRealSpeech(transport);
    await flush();

    expect(calls()).toBe(1); // 真语音段放行 → STT 被调用
    expect(loop.state).toBe('listening'); // 正常走完回合
  });

  it('不注入 gate → 伪段仍按现状送 ASR(逐字现状,零回归)', async () => {
    const { stt, calls } = countingStt();
    const { deps, transport } = makeDeps({ stt }); // 无 speechGate
    const loop = new VoiceLoop(deps);
    loop.start();

    await driveShortSilent(transport);
    await flush();

    expect(calls()).toBe(1); // 未门控:伪段照旧送 ASR(行为不变)
    expect(loop.state).toBe('listening');
  });
});
