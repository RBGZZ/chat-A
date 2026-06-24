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
import type { SttOptions, TtsOptions, PcmChunk, SttResult } from '@chat-a/providers';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps } from '../src/voice-loop';

/**
 * §4.1 语音 I/O 输入/输出语种解耦透传:VoiceLoop 经注入的 `sttLanguage`/`ttsOptions`
 * 把 input_lang→transcribe opts.language、output_lang/voice_id/clone_ref→synthesize opts。
 * **硬线:未注入 → STT 无 opts.language、synthesize opts===undefined(逐字现状,回归绿)。**
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

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
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

/** STT spy:记录每次 transcribe 收到的 opts;转写固定一句 final。 */
class SpyStt extends FakeStt {
  readonly seen: (SttOptions | undefined)[] = [];
  override async *transcribe(
    audio: AsyncIterable<PcmChunk>,
    opts?: SttOptions,
    signal?: AbortSignal,
  ): AsyncIterable<SttResult> {
    this.seen.push(opts);
    yield* super.transcribe(audio, opts, signal);
  }
}

/** TTS spy:记录每次 synthesize 收到的 opts。 */
class SpyTts extends FakeTts {
  readonly seen: (TtsOptions | undefined)[] = [];
  override async *synthesize(
    text: string,
    opts?: TtsOptions,
    signal?: AbortSignal,
  ): AsyncIterable<PcmChunk> {
    this.seen.push(opts);
    yield* super.synthesize(text, opts, signal);
  }
}

function makeDeps(
  stt: SpyStt,
  tts: SpyTts,
  over: Partial<VoiceLoopDeps> = {},
): { deps: VoiceLoopDeps; transport: InProcessAudioTransport } {
  const transport = new InProcessAudioTransport();
  const bus = new LightVoiceBus();
  const deps: VoiceLoopDeps = {
    transport,
    vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.0]),
    turnDetector: new TurnDetector(new StubEouModel([0.9])),
    stt,
    tts,
    send: async (_text, onToken) => {
      onToken('你好。');
      return '你好。';
    },
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport };
}

describe('runtime/VoiceLoop §4.1 语种解耦透传', () => {
  it('注入 sttLanguage → transcribe 收到 opts.language', async () => {
    const stt = new SpyStt({ script: [{ text: '你好', isFinal: true }] });
    const tts = new SpyTts({ samplesPerChar: 2 });
    const { deps, transport } = makeDeps(stt, tts, { sttLanguage: 'en' });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(stt.seen.length).toBeGreaterThan(0);
    expect(stt.seen[0]).toEqual({ language: 'en' });
  });

  it('注入 ttsOptions(language/voiceId/refAudio) → synthesize 收到对应 opts', async () => {
    const stt = new SpyStt({ script: [{ text: '你好', isFinal: true }] });
    const tts = new SpyTts({ samplesPerChar: 2 });
    const ttsOptions: TtsOptions = {
      language: 'zh',
      voiceId: 'xiaoxue_v2',
      refAudio: { source: '/r.wav', refText: '参考', refLang: 'zh' },
    };
    const { deps, transport } = makeDeps(stt, tts, { ttsOptions });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(tts.seen.length).toBeGreaterThan(0);
    expect(tts.seen[0]).toEqual(ttsOptions);
  });

  it('未注入 → transcribe 无 opts.language、synthesize opts===undefined(回归绿)', async () => {
    const stt = new SpyStt({ script: [{ text: '你好', isFinal: true }] });
    const tts = new SpyTts({ samplesPerChar: 2 });
    const { deps, transport } = makeDeps(stt, tts); // 不注入语种/音色
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(stt.seen[0]).toBeUndefined();
    expect(tts.seen.length).toBeGreaterThan(0);
    expect(tts.seen[0]).toBeUndefined();
  });

  it('注入不支持的语种 → provider fail-fast,VoiceLoop 降级回 listening 不崩', async () => {
    // STT 能力集仅 zh,却请求 ja → assertSttLanguage 抛错;VoiceLoop #transcribe catch 后降级。
    const stt = new SpyStt({ script: [{ text: '你好', isFinal: true }], capabilities: { languages: ['zh'] } });
    const tts = new SpyTts({ samplesPerChar: 2 });
    const { deps, transport } = makeDeps(stt, tts, { sttLanguage: 'ja' });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    // 不崩、干净回 listening(转写抛错降级路径)。
    expect(loop.state).toBe('listening');
  });
});
