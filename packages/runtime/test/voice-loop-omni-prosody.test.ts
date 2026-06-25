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
import { FakeStt, FakeTts, type PcmChunk } from '@chat-a/providers';
import type { SttEmotionLike } from '@chat-a/persona';
import { LightVoiceBus } from '../src/bus';
import { VoiceLoop } from '../src/voice-loop';
import type { VoiceLoopDeps, OmniAudioPort, OmniAudioOpts, VoiceOmniEvent } from '../src/voice-loop';

/**
 * omni 路「情感→PAD」链路(omni-prosody-to-pad 方案 A)的 VoiceLoop 集成测试。
 * 覆盖:注入钩子+尾部标签→钩子以正确情绪被调 + 标签不进 TTS/记忆；缺省不注入→零调用且仍剥标签；
 * 无标签→不调；多标签取最后；钩子抛错不中断回合；打断半句写回不含标签。
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

function fakeOmni(events: VoiceOmniEvent[], gate?: Promise<void>): OmniAudioPort {
  return {
    async *respondToAudio(
      audio: AsyncIterable<PcmChunk>,
      _o?: OmniAudioOpts,
      signal?: AbortSignal,
    ): AsyncIterable<VoiceOmniEvent> {
      const isAborted = (): boolean => signal?.aborted === true;
      for await (const _c of audio) void _c;
      let firstText = false;
      for (const ev of events) {
        if (isAborted()) throw new DOMException('aborted', 'AbortError');
        yield ev;
        if (ev.type === 'text' && !firstText && gate !== undefined) {
          firstText = true;
          await gate;
          if (isAborted()) throw new DOMException('aborted', 'AbortError');
        }
      }
    },
  };
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
    send: async () => '',
    memory: { appendMessage: vi.fn() },
    bus,
    sessionId: 's1',
    clock: () => 1000,
    ...over,
  };
  return { deps, transport, bus };
}

/** 记录所有喂给 TTS 的句子(从下行 tts:chunk 无法还原文本,故 spy synthesize 入参)。 */
function spyTtsText(deps: VoiceLoopDeps): string[] {
  const seen: string[] = [];
  const orig = deps.tts.synthesize.bind(deps.tts);
  vi.spyOn(deps.tts, 'synthesize').mockImplementation((sentence, opts, signal) => {
    seen.push(sentence);
    return orig(sentence, opts, signal);
  });
  return seen;
}

async function driveSpeechThenSilence(transport: InProcessAudioTransport): Promise<void> {
  for (const t of [0, 10, 20, 30, 40, 50, 10_050]) transport.sendAudio(micFrame(t));
  await flush();
}

async function flush(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

describe('runtime/VoiceLoop omni prosody→PAD（方案 A 显式标签）', () => {
  it('① 注入钩子 + 尾部标签：钩子以正确 SttEmotionLike 被调一次；标签不进 TTS', async () => {
    const calls: SttEmotionLike[] = [];
    const omni = fakeOmni([
      { type: 'transcript', text: '你好小雪' },
      { type: 'text', text: '你今天听起来有点累。' },
      { type: 'text', text: '[user_emotion:sad-7]' },
      { type: 'end' },
    ]);
    const { deps, transport } = makeDeps({
      omni,
      voicePath: 'omni',
      advanceProsody: (e) => {
        calls.push(e);
      },
    });
    const ttsText = spyTtsText(deps);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();

    expect(loop.state).toBe('listening');
    expect(calls).toEqual([{ label: 'sad', confidence: 0.7 }]);
    // 标签绝不进 TTS
    expect(ttsText.join('')).not.toContain('user_emotion');
    expect(ttsText.join('')).toContain('你今天听起来有点累');
  });

  it('② 缺省不注入钩子：零调用，但标签仍被剥除（不进 TTS）', async () => {
    const omni = fakeOmni([
      { type: 'transcript', text: '你好小雪' },
      { type: 'text', text: '好的呀。' },
      { type: 'text', text: '[user_emotion:happy-5]' },
      { type: 'end' },
    ]);
    // 不传 advanceProsody
    const { deps, transport } = makeDeps({ omni, voicePath: 'omni' });
    const ttsText = spyTtsText(deps);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();

    expect(loop.state).toBe('listening');
    expect(ttsText.join('')).not.toContain('user_emotion');
    expect(ttsText.join('')).toContain('好的呀');
  });

  it('③ 无标签：钩子不被调用，正文照常进 TTS', async () => {
    const calls: SttEmotionLike[] = [];
    const omni = fakeOmni([
      { type: 'transcript', text: '你好小雪' },
      { type: 'text', text: '就是普通的回复。' },
      { type: 'end' },
    ]);
    const { deps, transport } = makeDeps({
      omni,
      voicePath: 'omni',
      advanceProsody: (e) => {
        calls.push(e);
      },
    });
    const ttsText = spyTtsText(deps);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();

    expect(calls).toEqual([]);
    expect(ttsText.join('')).toContain('就是普通的回复');
  });

  it('④ 多标签：取最后一个喂钩子，所有标签均剥除', async () => {
    const calls: SttEmotionLike[] = [];
    const omni = fakeOmni([
      { type: 'transcript', text: '你好小雪' },
      { type: 'text', text: '嗯[user_emotion:happy-3]，' },
      { type: 'text', text: '不过你别太勉强。[user_emotion:angry-8]' },
      { type: 'end' },
    ]);
    const { deps, transport } = makeDeps({
      omni,
      voicePath: 'omni',
      advanceProsody: (e) => {
        calls.push(e);
      },
    });
    const ttsText = spyTtsText(deps);
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();

    expect(calls).toEqual([{ label: 'angry', confidence: 0.8 }]);
    expect(ttsText.join('')).not.toContain('user_emotion');
  });

  it('⑤ 钩子抛错：被捕获，omni 回合照常收尾不崩', async () => {
    const omni = fakeOmni([
      { type: 'transcript', text: '你好小雪' },
      { type: 'text', text: '你还好吗。' },
      { type: 'text', text: '[user_emotion:fearful-6]' },
      { type: 'end' },
    ]);
    const { deps, transport } = makeDeps({
      omni,
      voicePath: 'omni',
      advanceProsody: () => {
        throw new Error('PAD 推进失败(模拟)');
      },
    });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();

    expect(loop.state).toBe('listening'); // 不崩、正常收尾
  });

  it('⑥ 打断：半句写回内容不含标签', async () => {
    const calls: SttEmotionLike[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const omni = fakeOmni(
      [
        { type: 'transcript', text: '你好小雪' },
        { type: 'text', text: '我正在说一句话。' },
        { type: 'text', text: '后面[user_emotion:sad-7]' },
        { type: 'end' },
      ],
      gate,
    );
    const memCalls: unknown[] = [];
    const { deps, transport } = makeDeps({
      omni,
      voicePath: 'omni',
      advanceProsody: (e) => {
        calls.push(e);
      },
      memory: { appendMessage: vi.fn((m) => memCalls.push(m)) },
      vad: new StubVadDetector([0.9, 0.9, 0.9, 0.9, 0.0, 0.0, 0.0, 0.9, 0.9]),
    });
    const loop = new VoiceLoop(deps);
    loop.start();
    await driveSpeechThenSilence(transport);
    await flush();
    expect(loop.state).toBe('speaking');

    // 打断
    transport.sendAudio(micFrame(20_000));
    transport.sendAudio(micFrame(20_010));
    await flush();
    release();
    await flush();

    expect(loop.state).toBe('listening');
    const assistantWrite = memCalls.find(
      (m) => (m as { role: string }).role === 'assistant',
    ) as { content: string } | undefined;
    expect(assistantWrite).toBeDefined();
    expect(assistantWrite?.content).not.toContain('user_emotion');
    expect(assistantWrite?.content).toContain('[被用户打断]');
  });
});
