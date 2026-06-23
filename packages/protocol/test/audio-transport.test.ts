import { describe, it, expect, vi } from 'vitest';
import {
  InProcessAudioTransport,
  makeDataFrame,
  STT_AUDIO_FORMAT,
  TTS_AUDIO_FORMAT,
  SAMPLES_PER_FRAME,
  SAMPLE_RATE_HZ,
  type AudioFrame,
  type PcmFrame,
} from '../src/index';

// 真实 16kHz mono Int16 PCM 帧(10ms=160样本),对接 pcm.ts。
function makePcm(): PcmFrame {
  return {
    samples: new Int16Array(SAMPLES_PER_FRAME),
    sampleRate: SAMPLE_RATE_HZ,
    channels: 1,
    timestampMs: 0,
  };
}

// 上行帧:终端→大脑麦克风音频(audio:input,16kHz/mono/s16le)。
function makeUpstream(): AudioFrame {
  return makeDataFrame('audio:input', { audio: makePcm(), format: STT_AUDIO_FORMAT });
}

// 下行帧:大脑→终端 TTS 音频块(tts:chunk,24kHz/mono)。
function makeDownstream(seq: number): AudioFrame {
  return makeDataFrame('tts:chunk', {
    format: TTS_AUDIO_FORMAT,
    samples: new Int16Array([1, 2, 3]),
    seq,
  });
}

describe('InProcessAudioTransport — 上行 audio:input 投递', () => {
  it('send 上行帧 → listener 收到同一帧,格式字段完整(16kHz mono s16le)', () => {
    const t = new InProcessAudioTransport();
    const received: AudioFrame[] = [];
    t.onAudio((f) => received.push(f));

    const frame = makeUpstream();
    t.sendAudio(frame);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(frame); // 进程内直通:同一引用,无拷贝/序列化
    expect(received[0]!.type).toBe('audio:input');
    const payload = received[0]!.payload as { format: typeof STT_AUDIO_FORMAT; audio: PcmFrame };
    expect(payload.format.sampleRate).toBe(16_000);
    expect(payload.format.channels).toBe(1);
    expect(payload.format.sampleFormat).toBe('s16le');
    expect(payload.audio.samples).toBeInstanceOf(Int16Array);
    expect(payload.audio.samples.length).toBe(160);
  });
});

describe('InProcessAudioTransport — 下行 tts:chunk 投递', () => {
  it('send 下行帧 → listener 收到同一帧,格式字段 + seq 完整(24kHz mono)', () => {
    const t = new InProcessAudioTransport();
    const received: AudioFrame[] = [];
    t.onAudio((f) => received.push(f));

    const frame = makeDownstream(7);
    t.sendAudio(frame);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(frame);
    expect(received[0]!.type).toBe('tts:chunk');
    const payload = received[0]!.payload as { format: typeof TTS_AUDIO_FORMAT; seq: number; samples: Int16Array };
    expect(payload.format.sampleRate).toBe(24_000);
    expect(payload.format.channels).toBe(1);
    expect(payload.samples).toBeInstanceOf(Int16Array);
    expect(payload.seq).toBe(7);
  });
});

describe('InProcessAudioTransport — 多 listener / 无 listener', () => {
  it('多 listener 各收一份;返回的注销函数能单独移除', () => {
    const t = new InProcessAudioTransport();
    const a: AudioFrame[] = [];
    const b: AudioFrame[] = [];
    const offA = t.onAudio((f) => a.push(f));
    t.onAudio((f) => b.push(f));

    t.sendAudio(makeUpstream());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);

    offA(); // 只注销 A
    t.sendAudio(makeUpstream());
    expect(a).toHaveLength(1); // A 不再收
    expect(b).toHaveLength(2); // B 继续收
  });

  it('无 listener 时 send 静默丢弃,不抛(背压是 B 层的事,A 层不缓冲)', () => {
    const t = new InProcessAudioTransport();
    expect(() => t.sendAudio(makeUpstream())).not.toThrow();
  });

  it('单个 listener 抛错被捕获,不影响其它 listener(永不崩)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const t = new InProcessAudioTransport();
    const ok: AudioFrame[] = [];
    t.onAudio(() => {
      throw new Error('listener boom');
    });
    t.onAudio((f) => ok.push(f));

    expect(() => t.sendAudio(makeUpstream())).not.toThrow();
    expect(ok).toHaveLength(1); // 邻居仍收到
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('InProcessAudioTransport — close 后停止投递', () => {
  it('close 后 send 为 no-op,listener 不再收到', () => {
    const t = new InProcessAudioTransport();
    const received: AudioFrame[] = [];
    t.onAudio((f) => received.push(f));

    t.sendAudio(makeUpstream());
    expect(received).toHaveLength(1);

    t.close();
    t.sendAudio(makeUpstream());
    expect(received).toHaveLength(1); // close 后不再投递

    // close 幂等 + close 后订阅 no-op,返回安全的空注销
    expect(() => t.close()).not.toThrow();
    const off = t.onAudio((f) => received.push(f));
    t.sendAudio(makeUpstream());
    expect(received).toHaveLength(1);
    expect(() => off()).not.toThrow();
  });
});

describe('InProcessAudioTransport — 异步投递模式(async=true)', () => {
  it('async 模式下经微任务投递:send 后同步未到,微任务后到', async () => {
    const t = new InProcessAudioTransport({ async: true });
    const received: AudioFrame[] = [];
    t.onAudio((f) => received.push(f));

    t.sendAudio(makeDownstream(0));
    expect(received).toHaveLength(0); // 尚未投递(异步)
    await Promise.resolve(); // 排空微任务队列
    expect(received).toHaveLength(1);
  });
});
