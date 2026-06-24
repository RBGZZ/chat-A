import { describe, it, expect } from 'vitest';
import {
  QwenAsrStt,
  createStt,
  listSttKinds,
  loadSttConfig,
  pcmChunk,
  STT_SAMPLE_RATE_HZ,
  QWEN_ASR_DEFAULT_MODEL,
  QWEN_DASHSCOPE_COMPAT_BASE_URL,
} from '../src/index';
import type { PcmChunk, SttFetch, SttFetchResponse, SttResult } from '../src/index';

/** 把若干 PcmChunk 包成 AsyncIterable(模拟麦克风流)。 */
async function* streamOf(...chunks: PcmChunk[]): AsyncIterable<PcmChunk> {
  for (const c of chunks) yield c;
}
async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}
function chunkSecs(secs: number): PcmChunk {
  return pcmChunk(new Int16Array(Math.round(STT_SAMPLE_RATE_HZ * secs)), STT_SAMPLE_RATE_HZ);
}

/** 造一个注入式假 fetch:记录请求,回放罐装 JSON / 错误状态。不触网。 */
function mockFetch(opts: {
  json?: unknown;
  ok?: boolean;
  status?: number;
  statusText?: string;
  text?: string;
}): { fetch: SttFetch; calls: { url: string; body: unknown; headers: Record<string, string> }[] } {
  const calls: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetch: SttFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const res: SttFetchResponse = {
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      statusText: opts.statusText ?? 'OK',
      json: async () => opts.json ?? {},
      text: async () => opts.text ?? '',
    };
    return res;
  };
  return { fetch, calls };
}

/** 构造一条 chat/completions 罐装响应(可带情绪/语种标注)。 */
function asrResponse(content: string, annotations?: Record<string, unknown>[]): unknown {
  return {
    choices: [{ message: { content, ...(annotations ? { annotations } : {}) } }],
  };
}

function newAsr(fetch: SttFetch, extra: Record<string, unknown> = {}): QwenAsrStt {
  return new QwenAsrStt({
    model: QWEN_ASR_DEFAULT_MODEL,
    apiKey: 'sk-test',
    baseURL: QWEN_DASHSCOPE_COMPAT_BASE_URL,
    fetch,
    ...extra,
  });
}

describe('QwenAsrStt(注入 mock fetch,不触网)', () => {
  it('解析转写文本 + prosody 情绪(annotations[].emotion)', async () => {
    const { fetch } = mockFetch({
      json: asrResponse('今天好累啊', [{ type: 'audio_info', language: 'zh', emotion: 'sad' }]),
    });
    const results = await collect(newAsr(fetch).transcribe(streamOf(chunkSecs(1))));
    expect(results.length).toBe(1);
    expect(results[0]).toMatchObject<Partial<SttResult>>({
      text: '今天好累啊',
      isFinal: true,
      language: 'zh',
      emotion: { label: 'sad' },
    });
  });

  it('请求形态:POST /chat/completions,body 含 model + input_audio Data URL + asr_options.language', async () => {
    const { fetch, calls } = mockFetch({ json: asrResponse('hi', [{ emotion: 'happy' }]) });
    await collect(newAsr(fetch, { language: 'zh', enableItn: true }).transcribe(streamOf(chunkSecs(0.5))));
    expect(calls.length).toBe(1);
    const call = calls[0]!;
    expect(call.url).toBe(`${QWEN_DASHSCOPE_COMPAT_BASE_URL}/chat/completions`);
    expect(call.headers['authorization']).toBe('Bearer sk-test');
    const body = call.body as {
      model: string;
      messages: { role: string; content: { type: string; input_audio: { data: string } }[] }[];
      asr_options: { language: string; enable_itn: boolean };
    };
    expect(body.model).toBe(QWEN_ASR_DEFAULT_MODEL);
    const audio = body.messages[0]!.content[0]!;
    expect(audio.type).toBe('input_audio');
    expect(audio.input_audio.data.startsWith('data:audio/wav;base64,')).toBe(true);
    expect(body.asr_options).toEqual({ language: 'zh', enable_itn: true });
  });

  it('无 annotations → 结果不含 emotion 键(纯加法)', async () => {
    const { fetch } = mockFetch({ json: asrResponse('你好') });
    const results = await collect(newAsr(fetch).transcribe(streamOf(chunkSecs(1))));
    expect(results[0]!.text).toBe('你好');
    expect('emotion' in results[0]!).toBe(false);
  });

  it('非法 emotion 值被忽略(不设 emotion 键,不抛)', async () => {
    const { fetch } = mockFetch({
      json: asrResponse('嗯', [{ emotion: '__bogus__' }]),
    });
    const results = await collect(newAsr(fetch).transcribe(streamOf(chunkSecs(1))));
    expect('emotion' in results[0]!).toBe(false);
  });

  it('缺 apiKey 构造即 fail-fast(提示环境变量,不返回不可用实例)', () => {
    const { fetch } = mockFetch({ json: asrResponse('x') });
    expect(
      () => new QwenAsrStt({ model: 'm', apiKey: '', baseURL: 'http://x/v1', fetch }),
    ).toThrow(/CHAT_A_DASHSCOPE_API_KEY/);
  });

  it('限定语种 + 外语种 → 发请求前 fail-fast', async () => {
    const { fetch, calls } = mockFetch({ json: asrResponse('x') });
    const asr = newAsr(fetch, { languages: ['en'] });
    await expect(collect(asr.transcribe(streamOf(chunkSecs(1)), { language: 'zh' }))).rejects.toThrow(
      /不支持语种 "zh"/,
    );
    expect(calls.length).toBe(0); // 未发请求。
  });

  it('HTTP 非 2xx → 抛清晰中文错误(含 status,不含 key)', async () => {
    const { fetch } = mockFetch({ ok: false, status: 500, statusText: 'Internal Error', text: 'boom' });
    const asr = newAsr(fetch);
    await expect(collect(asr.transcribe(streamOf(chunkSecs(1))))).rejects.toThrow(/HTTP 500/);
    const { fetch: f2 } = mockFetch({ ok: false, status: 401, statusText: 'Unauthorized', text: 'bad key' });
    await expect(collect(newAsr(f2).transcribe(streamOf(chunkSecs(1))))).rejects.not.toThrow(/sk-test/);
  });

  it('进入即 aborted → 不发请求、空产出', async () => {
    const ac = new AbortController();
    ac.abort();
    const { fetch, calls } = mockFetch({ json: asrResponse('x') });
    const results = await collect(newAsr(fetch).transcribe(streamOf(chunkSecs(1)), undefined, ac.signal));
    expect(results).toEqual([]);
    expect(calls.length).toBe(0);
  });

  it('能力声明:多语种 / 批式非流式 / 16kHz', () => {
    const { fetch } = mockFetch({ json: asrResponse('x') });
    expect(newAsr(fetch).capabilities).toEqual({
      languages: ['*'],
      streaming: false,
      sampleRate: STT_SAMPLE_RATE_HZ,
    });
  });
});

describe('createStt / loadSttConfig:qwen-asr 工厂与配置', () => {
  it('createStt(kind:qwen-asr, 注入 fetch)→ QwenAsrStt 并能转写出情绪', async () => {
    const { fetch } = mockFetch({ json: asrResponse('好开心', [{ emotion: 'happy' }]) });
    const stt = createStt(
      {
        kind: 'qwen-asr',
        model: QWEN_ASR_DEFAULT_MODEL,
        apiKey: 'sk-x',
        baseURL: QWEN_DASHSCOPE_COMPAT_BASE_URL,
      },
      { fetch },
    );
    expect(stt).toBeInstanceOf(QwenAsrStt);
    const results = await collect(stt.transcribe(streamOf(chunkSecs(1))));
    expect(results[0]).toMatchObject({ text: '好开心', emotion: { label: 'happy' } });
  });

  it('createStt(kind:qwen-asr)缺 apiKey → 明确报错', () => {
    expect(() =>
      createStt({ kind: 'qwen-asr', model: 'm', apiKey: '', baseURL: 'http://x/v1' }),
    ).toThrow(/CHAT_A_DASHSCOPE_API_KEY/);
  });

  it('listSttKinds 含 qwen-asr', () => {
    expect([...listSttKinds()]).toContain('qwen-asr');
  });

  it('loadSttConfig:CHAT_A_STT_KIND=qwen-asr(apiKey 回落 DASHSCOPE,model/baseURL 内置默认)', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'qwen-asr',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
    });
    expect(cfg).toEqual({
      kind: 'qwen-asr',
      model: QWEN_ASR_DEFAULT_MODEL,
      apiKey: 'sk-dash',
      baseURL: QWEN_DASHSCOPE_COMPAT_BASE_URL,
    });
  });

  it('loadSttConfig:CHAT_A_STT_API_KEY 优先于 DASHSCOPE;ENABLE_ITN/LANGUAGE 透传', () => {
    const cfg = loadSttConfig({
      CHAT_A_STT_KIND: 'qwen-asr',
      CHAT_A_STT_API_KEY: 'sk-explicit',
      CHAT_A_DASHSCOPE_API_KEY: 'sk-dash',
      CHAT_A_STT_LANGUAGE: 'zh',
      CHAT_A_STT_ENABLE_ITN: 'true',
    });
    if (cfg.kind !== 'qwen-asr') throw new Error('类型收窄');
    expect(cfg.apiKey).toBe('sk-explicit');
    expect(cfg.language).toBe('zh');
    expect(cfg.enableItn).toBe(true);
  });
});
