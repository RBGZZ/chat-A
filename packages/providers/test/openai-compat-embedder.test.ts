import { describe, it, expect, vi, afterEach } from 'vitest';
import { OpenAiCompatEmbedder } from '../src/index';

/** mock fetch:返回给定 JSON,并捕获最后一次请求的 url/body 供断言。 */
function mockJson(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): {
  url: () => string | undefined;
  body: () => any;
} {
  const captured: { url?: string; value?: any } = {};
  const fn = vi.fn(async (url: string, req?: RequestInit) => {
    captured.url = url;
    captured.value = req?.body ? JSON.parse(req.body as string) : undefined;
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: init.statusText ?? 'OK',
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { url: () => captured.url, body: () => captured.value };
}

function makeEmbedder() {
  return new OpenAiCompatEmbedder({
    id: 'openai',
    model: 'text-embedding-3-small',
    apiKey: 'k',
    baseURL: 'https://api.example.com/v1/',
    dimension: 3,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAiCompatEmbedder(请求组装)', () => {
  it('打到 /embeddings,带 model/input/dimensions,Bearer 鉴权;末尾斜杠被去掉', async () => {
    const cap = mockJson({
      data: [
        { index: 0, embedding: [0.1, 0.2, 0.3] },
        { index: 1, embedding: [0.4, 0.5, 0.6] },
      ],
    });
    const e = makeEmbedder();
    await e.embed(['你好', '小雪']);
    expect(cap.url()).toBe('https://api.example.com/v1/embeddings');
    expect(cap.body()).toEqual({
      model: 'text-embedding-3-small',
      input: ['你好', '小雪'],
      dimensions: 3,
    });
  });

  it('空输入 → 不发请求,返回空数组', async () => {
    const cap = mockJson({ data: [] });
    const e = makeEmbedder();
    expect(await e.embed([])).toEqual([]);
    expect(cap.body()).toBeUndefined();
  });

  it('dimension 为能力声明位', () => {
    expect(makeEmbedder().dimension).toBe(3);
  });

  it('非法维度抛错', () => {
    expect(
      () => new OpenAiCompatEmbedder({ id: 'x', model: 'm', apiKey: 'k', baseURL: 'b', dimension: 0 }),
    ).toThrow();
  });
});

describe('OpenAiCompatEmbedder(响应解析)', () => {
  it('按 index 归位(乱序也对齐输入顺序)', async () => {
    mockJson({
      data: [
        { index: 1, embedding: [9, 9, 9] },
        { index: 0, embedding: [1, 1, 1] },
      ],
    });
    const e = makeEmbedder();
    const out = await e.embed(['first', 'second']);
    expect(out).toEqual([
      [1, 1, 1],
      [9, 9, 9],
    ]);
  });
});

describe('OpenAiCompatEmbedder(容错降级位)', () => {
  it('HTTP 非 2xx → 抛带 status 与正文片段的 Error', async () => {
    mockJson('rate limited', { ok: false, status: 429, statusText: 'Too Many Requests' });
    const e = makeEmbedder();
    await expect(e.embed(['x'])).rejects.toThrow(/openai HTTP 429 Too Many Requests.*rate limited/);
  });

  it('返回条数不符 → 抛错(交上层降级)', async () => {
    mockJson({ data: [{ index: 0, embedding: [1, 2, 3] }] });
    const e = makeEmbedder();
    await expect(e.embed(['a', 'b'])).rejects.toThrow(/条数不符/);
  });

  it('向量维度不符 → 抛错', async () => {
    mockJson({ data: [{ index: 0, embedding: [1, 2] }] });
    const e = makeEmbedder();
    await expect(e.embed(['a'])).rejects.toThrow(/维度不符/);
  });

  it('缺某个 index 的向量(重复 index 导致空洞)→ 抛错', async () => {
    mockJson({
      data: [
        { index: 0, embedding: [1, 1, 1] },
        { index: 0, embedding: [2, 2, 2] },
      ],
    });
    const e = makeEmbedder();
    await expect(e.embed(['a', 'b'])).rejects.toThrow(/缺少 index 1/);
  });
});
