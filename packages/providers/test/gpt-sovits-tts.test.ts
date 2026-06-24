import { describe, it, expect } from 'vitest';
import { GptSoVitsTts, createTts } from '../src/index';
import type { FetchLike, PcmChunk } from '../src/index';

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** s16le 样本数组 → 字节(模拟服务端裸 PCM 块)。 */
function int16ToBytes(samples: number[]): Uint8Array {
  const buf = new Uint8Array(samples.length * 2);
  const view = new DataView(buf.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(i * 2, samples[i] as number, true);
  return buf;
}

/** 把若干字节块包成异步可迭代 body(模拟流式 chunked)。 */
async function* streamOf(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) {
    yield c;
    await Promise.resolve(); // 让出一拍,贴近真实流式。
  }
}

interface Captured {
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
  body: Record<string, unknown>;
}

/** 构造一个注入 fetch:返回 200 + 给定流式块;记录每次请求(含解析后的 body)。 */
function okFetch(chunks: Uint8Array[]): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({
      url,
      ...(init ? { init } : {}),
      body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {},
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: streamOf(chunks),
      text: () => Promise.resolve(''),
    });
  };
  return { fetch, calls };
}

/** 构造一个注入 fetch:返回非 2xx + 错误 body。 */
function errFetch(status: number, detail: string): { fetch: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, ...(init ? { init } : {}), body: init?.body ? JSON.parse(init.body) : {} });
    return Promise.resolve({
      ok: false,
      status,
      statusText: 'Bad Request',
      body: null,
      text: () => Promise.resolve(detail),
    });
  };
  return { fetch, calls };
}

function newTts(fetch: FetchLike, extra: Record<string, unknown> = {}): GptSoVitsTts {
  return new GptSoVitsTts({
    baseURL: 'http://127.0.0.1:9880',
    textLang: 'zh',
    refAudioPath: '/samples/xiaoxue.wav',
    promptText: '你好呀',
    promptLang: 'zh',
    fetch,
    ...extra,
  });
}

describe('GptSoVitsTts(注入 mock fetch,不触网)', () => {
  it('能力声明:voiceCloning=true / streaming=true / 采样率默认 32000', () => {
    const { fetch } = okFetch([]);
    const tts = newTts(fetch);
    expect(tts.capabilities.voiceCloning).toBe(true);
    expect(tts.capabilities.streaming).toBe(true);
    expect(tts.capabilities.sampleRate).toBe(32000);
    expect(tts.capabilities.languages).toEqual(['*']);
  });

  it('正常流式:多块裸 PCM → 对应 PcmChunk(采样率/mono/Int16)', async () => {
    const { fetch } = okFetch([int16ToBytes([1, -1]), int16ToBytes([100, -100, 32767])]);
    const tts = newTts(fetch, { sampleRate: 32000 });
    const chunks = await collect(tts.synthesize('你好'));
    expect(chunks.length).toBe(2);
    const c0 = chunks[0] as PcmChunk;
    expect(c0.sampleRate).toBe(32000);
    expect(c0.channels).toBe(1);
    expect([...c0.samples]).toEqual([1, -1]);
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([100, -100, 32767]);
  });

  it('请求构造:POST /tts,带 streaming_mode/media_type=raw + 默认参考参数', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([1])]);
    const tts = newTts(fetch);
    await collect(tts.synthesize('讲个故事'));
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe('http://127.0.0.1:9880/tts');
    expect(call.init?.method).toBe('POST');
    expect(call.body['text']).toBe('讲个故事');
    expect(call.body['text_lang']).toBe('zh');
    expect(call.body['ref_audio_path']).toBe('/samples/xiaoxue.wav');
    expect(call.body['prompt_text']).toBe('你好呀');
    expect(call.body['prompt_lang']).toBe('zh');
    expect(call.body['media_type']).toBe('raw');
    expect(call.body['streaming_mode']).toBe(true);
  });

  it('复刻参数进请求体:opts.refAudio(source/refText/refLang)+ opts.language 覆盖默认', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([1])]);
    const tts = newTts(fetch);
    await collect(
      tts.synthesize('合成这句', {
        language: 'en',
        refAudio: { source: '/r/other.wav', refText: 'hello there', refLang: 'en' },
      }),
    );
    const b = calls[0]!.body;
    expect(b['text_lang']).toBe('en');
    expect(b['ref_audio_path']).toBe('/r/other.wav');
    expect(b['prompt_text']).toBe('hello there');
    expect(b['prompt_lang']).toBe('en');
  });

  it('config 默认回落:不传 opts.refAudio → 用 config 的 ref/prompt', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([1])]);
    const tts = newTts(fetch);
    await collect(tts.synthesize('普通合成'));
    const b = calls[0]!.body;
    expect(b['ref_audio_path']).toBe('/samples/xiaoxue.wav');
    expect(b['prompt_text']).toBe('你好呀');
    expect(b['prompt_lang']).toBe('zh');
  });

  it('能力门:voiceCloning=true 放行带 refAudio 的请求', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([7])]);
    const tts = newTts(fetch);
    const chunks = await collect(
      tts.synthesize('用复刻音色', { refAudio: { source: '/r/x.wav' } }),
    );
    expect(chunks.length).toBe(1); // 未被 assertTtsCloning 拦截。
    expect(calls.length).toBe(1);
  });

  it('能力门:限定语种 + 外语种 → fail-fast(不发请求)', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([1])]);
    const tts = newTts(fetch, { languages: ['zh'] });
    await expect(collect(tts.synthesize('hi', { language: 'en' }))).rejects.toThrow(
      /不支持语种 "en"/,
    );
    expect(calls.length).toBe(0);
  });

  it('无任何参考音频 → fail-fast 中文错(不发请求)', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([1])]);
    const tts = new GptSoVitsTts({ baseURL: 'http://127.0.0.1:9880', textLang: 'zh', fetch });
    await expect(collect(tts.synthesize('没有参考音频'))).rejects.toThrow(/缺少参考音频/);
    expect(calls.length).toBe(0);
  });

  it('AbortSignal:进入即已取消 → 空产出、不发请求', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch, calls } = okFetch([int16ToBytes([5])]);
    const tts = newTts(fetch);
    const chunks = await collect(tts.synthesize('长文本', undefined, ac.signal));
    expect(chunks).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('AbortSignal:中途取消 → 停止产出', async () => {
    const ac = new AbortController();
    const { fetch } = okFetch([int16ToBytes([1]), int16ToBytes([2]), int16ToBytes([3])]);
    const tts = newTts(fetch);
    const got: PcmChunk[] = [];
    for await (const c of tts.synthesize('长文本', undefined, ac.signal)) {
      got.push(c);
      ac.abort(); // 收首块即打断。
    }
    expect(got.length).toBe(1); // 取消后不再产出后续块。
  });

  it('优雅降级:HTTP 非 2xx → 抛含状态码 + 正文片段的中文错', async () => {
    const { fetch } = errFetch(400, '{"message":"bad ref_audio_path"}');
    const tts = newTts(fetch);
    await expect(collect(tts.synthesize('x'))).rejects.toThrow(/HTTP 400/);
    await expect(collect(newTts(errFetch(400, 'bad ref_audio_path').fetch).synthesize('x'))).rejects.toThrow(
      /bad ref_audio_path/,
    );
  });

  it('跨块半样本:奇数字节块进位下一块,不产半样本', async () => {
    // 第一块 3 字节(1.5 样本),第二块 1 字节 → 合并成 2 字节 = 1 样本。
    const { fetch } = okFetch([new Uint8Array([0x01, 0x00, 0x02]), new Uint8Array([0x00])]);
    const tts = newTts(fetch);
    const chunks = await collect(tts.synthesize('x'));
    expect(chunks.length).toBe(2);
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([1]); // 0x0001
    expect([...(chunks[1] as PcmChunk).samples]).toEqual([2]); // 残留 0x02 + 0x00 → 0x0002
  });
});

describe('createTts:gpt-sovits 工厂装配', () => {
  it('createTts(kind:gpt-sovits, 注入 fetch)→ GptSoVitsTts 并能流式合成', async () => {
    const { fetch, calls } = okFetch([int16ToBytes([9])]);
    const tts = createTts(
      {
        kind: 'gpt-sovits',
        baseURL: 'http://127.0.0.1:9880',
        textLang: 'zh',
        refAudioPath: '/samples/xiaoxue.wav',
        promptText: '你好呀',
        promptLang: 'zh',
      },
      { fetch },
    );
    expect(tts).toBeInstanceOf(GptSoVitsTts);
    const chunks = await collect(tts.synthesize('合成'));
    expect([...(chunks[0] as PcmChunk).samples]).toEqual([9]);
    expect(calls[0]!.body['ref_audio_path']).toBe('/samples/xiaoxue.wav');
  });
});
