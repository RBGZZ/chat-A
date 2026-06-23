import { describe, it, expect } from 'vitest';
import {
  FakeStt,
  createStt,
  listSttKinds,
  loadSttConfig,
  pcmChunk,
  OpenAiCompatStt,
  STT_SAMPLE_RATE_HZ,
} from '../src/index';
import type { PcmChunk, SttConfig, SttResult } from '../src/index';

/** 把若干 PcmChunk 包成 AsyncIterable(模拟麦克风流)。 */
async function* streamOf(...chunks: PcmChunk[]): AsyncIterable<PcmChunk> {
  for (const c of chunks) yield c;
}

/** 收集异步流为数组。 */
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

/** 造一个 N 秒的 16kHz mono 块(样本值无所谓,FakeStt 只看长度)。 */
function chunkSecs(secs: number): PcmChunk {
  return pcmChunk(new Int16Array(Math.round(STT_SAMPLE_RATE_HZ * secs)), STT_SAMPLE_RATE_HZ);
}

describe('FakeStt(确定性 partial→final)', () => {
  it('每块一条 partial,流尾一条 final;确定性可断言', async () => {
    const stt = new FakeStt();
    const results = await collect(stt.transcribe(streamOf(chunkSecs(1.0), chunkSecs(0.5))));

    expect(results.map((r) => r.isFinal)).toEqual([false, false, true]);
    expect(results[0]).toMatchObject({ text: '块#0:1.0s', isFinal: false });
    expect(results[1]).toMatchObject({ text: '块#0:1.0s 块#1:0.5s', isFinal: false });
    expect(results[2]).toMatchObject({ text: '转写[块#0:1.0s 块#1:0.5s]', isFinal: true });
  });

  it('两次运行结果完全一致(确定性)', async () => {
    const stt = new FakeStt();
    const a = await collect(stt.transcribe(streamOf(chunkSecs(0.3))));
    const b = await collect(stt.transcribe(streamOf(chunkSecs(0.3))));
    expect(a).toEqual(b);
  });

  it('空音频 → 仅一条 final', async () => {
    const stt = new FakeStt();
    const results = await collect(stt.transcribe(streamOf()));
    expect(results).toEqual<SttResult[]>([{ text: '(空音频)', isFinal: true }]);
  });

  it('注入 script → 逐条回放(record-replay)', async () => {
    const script: SttResult[] = [
      { text: '你', isFinal: false },
      { text: '你好', isFinal: true },
    ];
    const stt = new FakeStt({ script });
    expect(await collect(stt.transcribe(streamOf(chunkSecs(1))))).toEqual(script);
  });

  it('opts.language 透传进结果', async () => {
    const stt = new FakeStt();
    const results = await collect(stt.transcribe(streamOf(chunkSecs(1)), { language: 'zh' }));
    expect(results.every((r) => r.language === 'zh')).toBe(true);
  });
});

describe('STT 能力声明 + 能力门 fail-fast(§4.3)', () => {
  it('默认能力:多语种 / 流式 / 16kHz', () => {
    const stt = new FakeStt();
    expect(stt.capabilities).toEqual({ languages: ['*'], streaming: true, sampleRate: STT_SAMPLE_RATE_HZ });
  });

  it('限定语种集 + 请求外语种 → fail-fast', async () => {
    const stt = new FakeStt({ capabilities: { languages: ['zh', 'en'] } });
    await expect(collect(stt.transcribe(streamOf(chunkSecs(1)), { language: 'ja' }))).rejects.toThrow(
      /不支持语种 "ja"/,
    );
  });

  it('限定语种集 + 请求集内语种 → 放行', async () => {
    const stt = new FakeStt({ capabilities: { languages: ['zh'] } });
    const results = await collect(stt.transcribe(streamOf(chunkSecs(1)), { language: 'zh' }));
    expect(results.at(-1)?.isFinal).toBe(true);
  });

  it('OpenAiCompatStt 能力:批式非流式 / 16kHz', () => {
    const stt = new OpenAiCompatStt({ id: 'openai', model: 'whisper-1', apiKey: 'k', baseURL: 'http://x/v1' });
    expect(stt.capabilities.streaming).toBe(false);
    expect(stt.capabilities.sampleRate).toBe(STT_SAMPLE_RATE_HZ);
  });

  it('OpenAiCompatStt 限定语种 + 外语种 → 发请求前 fail-fast', async () => {
    const stt = new OpenAiCompatStt({
      id: 'openai',
      model: 'whisper-1',
      apiKey: 'k',
      baseURL: 'http://x/v1',
      languages: ['en'],
    });
    await expect(collect(stt.transcribe(streamOf(chunkSecs(1)), { language: 'zh' }))).rejects.toThrow(
      /不支持语种 "zh"/,
    );
  });
});

describe('createStt(工厂按判别联合切换)+ loadSttConfig', () => {
  it('kind: fake → FakeStt(languages 透传能力)', () => {
    const stt = createStt({ kind: 'fake', languages: ['zh'] });
    expect(stt).toBeInstanceOf(FakeStt);
    expect(stt.capabilities.languages).toEqual(['zh']);
  });

  it('kind: openai-compat → OpenAiCompatStt(真实字段透传)', () => {
    const stt = createStt({
      kind: 'openai-compat',
      id: 'groq-whisper',
      model: 'distil-whisper-large-v3-en',
      apiKey: 'k',
      baseURL: 'https://api.groq.com/openai/v1',
      language: 'en',
      responseFormat: 'json',
      temperature: 0,
    });
    expect(stt).toBeInstanceOf(OpenAiCompatStt);
    expect(stt.id).toBe('groq-whisper');
  });

  it('kind: whisper-local 未注入 spawn → 明确报错"需运行时端口"(非崩,非"尚未接入")', () => {
    expect(() =>
      createStt({ kind: 'whisper-local', model: 'large-v3', device: 'cuda', computeType: 'float16' }),
    ).toThrow(/需运行时提供 spawn 端口/);
  });

  it('未知 kind → 抛错并列出已注册项', () => {
    expect(() => createStt({ kind: 'nope' } as unknown as SttConfig)).toThrow(/unknown STT kind "nope"/);
  });

  it('已注册 kind 列表', () => {
    expect([...listSttKinds()].sort()).toEqual(['fake', 'openai-compat', 'whisper-local']);
  });

  it('全空 env → 降级 fake', () => {
    expect(loadSttConfig({})).toEqual({ kind: 'fake' });
  });

  it('齐备 openai-compat env → openai-compat(真实字段)', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_MODEL: 'whisper-1',
      CHAT_A_STT_API_KEY: 'k',
      CHAT_A_STT_BASE_URL: 'https://api.openai.com/v1',
      CHAT_A_STT_LANGUAGE: 'zh',
      CHAT_A_STT_RESPONSE_FORMAT: 'verbose_json',
      CHAT_A_STT_TEMPERATURE: '0.2',
    });
    expect(cfg).toEqual({
      kind: 'openai-compat',
      model: 'whisper-1',
      apiKey: 'k',
      baseURL: 'https://api.openai.com/v1',
      language: 'zh',
      responseFormat: 'verbose_json',
      temperature: 0.2,
    });
  });

  it('whisper-local env → 真实本地引擎字段', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'whisper-local',
      CHAT_A_STT_MODEL: 'large-v3',
      CHAT_A_STT_DEVICE: 'cuda',
      CHAT_A_STT_COMPUTE_TYPE: 'float16',
      CHAT_A_STT_BEAM_SIZE: '5',
      CHAT_A_STT_VAD_FILTER: 'true',
    });
    expect(cfg).toEqual({
      kind: 'whisper-local',
      model: 'large-v3',
      device: 'cuda',
      computeType: 'float16',
      beamSize: 5,
      vadFilter: true,
    });
  });

  it('exactOptionalPropertyTypes 合规:fake 不带 languages 时不含该键', () => {
    const cfg = loadSttConfig({});
    expect('languages' in cfg).toBe(false);
  });
});
