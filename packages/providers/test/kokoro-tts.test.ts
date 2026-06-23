import { describe, it, expect } from 'vitest';
import { KokoroTts, createTts, TTS_SAMPLE_RATE_HZ } from '../src/index';
import type { PcmChunk, KokoroSession } from '../src/index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** 假整段 session:返回固定 Float32 PCM,并记录收到的 (text,voice,speed)。 */
function fakeSessionWhole(samples: Float32Array): {
  session: KokoroSession;
  calls: { text: string; voice: string; speed: number }[];
} {
  const calls: { text: string; voice: string; speed: number }[] = [];
  const session: KokoroSession = {
    synthesize(text, voice, speed) {
      calls.push({ text, voice, speed });
      return Promise.resolve(samples);
    },
  };
  return { session, calls };
}

/** 假分块 session:返回 Float32 块流(测试流式逐块 yield)。 */
function fakeSessionChunked(...blocks: Float32Array[]): KokoroSession {
  return {
    synthesize() {
      async function* gen(): AsyncIterable<Float32Array> {
        for (const b of blocks) yield b;
      }
      return gen();
    },
  };
}

describe('KokoroTts(注入式 KokoroSession → Float32→Int16 PcmChunk)', () => {
  it('假 session 返回固定 Float32 → 产对应 PcmChunk(24kHz mono,Int16 转码正确)', async () => {
    // 0.0 → 0;1.0 → 32767;-1.0 → -32768;0.5 → round(0.5*32767)=16384。
    const { session } = fakeSessionWhole(new Float32Array([0, 1, -1, 0.5]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session });
    const chunks = await collect(tts.synthesize('你好'));
    expect(chunks.length).toBe(1);
    const c = chunks[0] as PcmChunk;
    expect(c.sampleRate).toBe(TTS_SAMPLE_RATE_HZ);
    expect(c.channels).toBe(1);
    expect([...c.samples]).toEqual([0, 32767, -32768, 16384]);
  });

  it('透传 text/voice/speed 给 session(voiceId 覆盖默认音色)', async () => {
    const { session, calls } = fakeSessionWhole(new Float32Array([0.1]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session, speed: 1.0 });
    await collect(tts.synthesize('讲个故事', { voiceId: 'am_adam', speed: 1.3 }));
    expect(calls[0]).toEqual({ text: '讲个故事', voice: 'am_adam', speed: 1.3 });
  });

  it('分块 session → 逐块流式 yield(空块跳过)', async () => {
    const session = fakeSessionChunked(
      new Float32Array([1]),
      new Float32Array([]), // 空块应跳过
      new Float32Array([-1, 0]),
    );
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session });
    const chunks = await collect(tts.synthesize('两段'));
    expect(chunks.length).toBe(2);
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([32767]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([-32768, 0]);
  });

  it('空音频(session 返回空 Float32)→ 不产块', async () => {
    const { session } = fakeSessionWhole(new Float32Array([]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session });
    expect(await collect(tts.synthesize(''))).toEqual([]);
  });

  it('能力声明:24kHz / 流式 / voiceCloning=false', () => {
    const { session } = fakeSessionWhole(new Float32Array([0]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session });
    expect(tts.capabilities).toEqual({
      languages: ['*'],
      voiceId: ['af_bella'],
      sampleRate: TTS_SAMPLE_RATE_HZ,
      streaming: true,
      voiceCloning: false,
    });
  });

  it('能力门:不支持复刻却传 refAudio → fail-fast', async () => {
    const { session } = fakeSessionWhole(new Float32Array([0]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session });
    await expect(collect(tts.synthesize('hi', { refAudio: { source: '/r.wav' } }))).rejects.toThrow(
      /不支持音色复刻/,
    );
  });

  it('能力门:限定语种 + 外语种 → fail-fast', async () => {
    const { session } = fakeSessionWhole(new Float32Array([0]));
    const tts = new KokoroTts({ id: 'kokoro', voice: 'af_bella', session, languages: ['en'] });
    await expect(collect(tts.synthesize('你好', { language: 'zh' }))).rejects.toThrow(/不支持语种 "zh"/);
  });

  it('缺 session 端口 → 构造即 fail-fast(明确"需运行时提供 session")', () => {
    expect(
      () => new KokoroTts({ id: 'kokoro', voice: 'af_bella', session: undefined as unknown as KokoroSession }),
    ).toThrow(/需运行时提供 session 端口/);
  });
});

describe('createTts 注入端口(工厂层)', () => {
  it('注入 kokoroSession → 建真适配并能合成', async () => {
    const { session } = fakeSessionWhole(new Float32Array([0.25]));
    const tts = createTts({ kind: 'kokoro', id: 'k', voice: 'af_sky' }, { kokoroSession: session });
    expect(tts).toBeInstanceOf(KokoroTts);
    expect(tts.id).toBe('k');
    const chunks = await collect(tts.synthesize('合成'));
    expect((chunks[0] as PcmChunk).samples.length).toBe(1);
  });

  it('未注入 session → 明确报错(非崩)', () => {
    expect(() => createTts({ kind: 'kokoro', voice: 'af_bella' })).toThrow(/需运行时提供 session 端口/);
  });
});
